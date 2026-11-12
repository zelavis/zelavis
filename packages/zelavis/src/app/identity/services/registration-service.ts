import { Cause, Effect, Schema } from "effect";
import { evaluate, integration, present, unwrapFailure } from "../../../core/runtime/effect-boundary.js";
import type {
  AuthorizationCodeIdentity,
  CredentialEnrollmentInput,
  CredentialProvider,
  PreparedCredential,
} from "../contracts/credential-provider.js";
import type { IdentityRepositories, Mutation } from "../contracts/repositories.js";
import {
  IdentityConflictError,
  IdentityNotFoundError,
  IdentityValidationError,
  RegistrationError,
  RegistrationRateLimitError,
} from "../core/errors.js";
import {
  decodeRegistrationControl,
  decodeSetRegistrationSettingsInput,
  REGISTRATION_ATTEMPT_LIMIT,
  REGISTRATION_SLOT_LIMIT,
  REGISTRATION_WINDOW_MS,
  type EnrollmentSlot,
  type RegistrationControl,
  type RegistrationServiceOptions,
  type RegistrationSettings,
  type RegistrationStatus,
  type SetRegistrationSettingsInput,
} from "../domain/registration.js";
import type { Account, Credential, IssuedSession } from "../domain/entities.js";
import type { AccountService } from "./account-service.js";
import type { CredentialService } from "./credential-service.js";
import type { SessionService } from "./session-service.js";

const publicIdentifier = Schema.Trimmed.check(Schema.isBetweenLength(1, 254));
const displayName = Schema.Trimmed.check(Schema.isBetweenLength(1, 120));
const passwordInput = Schema.Struct({
  identifier: publicIdentifier,
  password: Schema.String.check(Schema.isMaxLength(1024)),
  displayName: Schema.optionalKey(displayName),
});
const genericInput = Schema.StructWithRest(
  Schema.Struct({ identifier: publicIdentifier, displayName: Schema.optionalKey(displayName) }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const decodePasswordInput = Schema.decodeUnknownSync(passwordInput, { onExcessProperty: "error" });
const decodeGenericInput = Schema.decodeUnknownSync(genericInput);
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const reservedFields = new Set([
  "id", "role", "roles", "permission", "permissions",
  "grants", "tenant", "tenantId", "verified", "metadata", "registrationPending", "scope", "scopes",
  "authority", "project", "projectId", "sessionEpoch",
]);

function decodeEnrollmentInput(provider: string, body: unknown): CredentialEnrollmentInput & { displayName?: string } {
  // The HTTP body is bounded separately. JS callers and generic providers get
  // the same field, depth and string bounds before preparation runs.
  let count = 0;
  let characters = 0;
  function bounded(value: unknown, depth: number): boolean {
    if (++count > 128 || depth > 4) return false;
    if (typeof value === "string") {
      characters += value.length;
      return value.length <= 8192 && characters <= 8192;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return true;
    if (Array.isArray(value)) return value.length <= 32 && value.every((item) => bounded(item, depth + 1));
    if (typeof value !== "object" || value === null) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value);
    return entries.length <= 32 && entries.every(([key, item]) =>
      key.length <= 96 && !unsafeObjectKeys.has(key) &&
      (depth !== 0 || !reservedFields.has(key)) && bounded(item, depth + 1));
  }

  if (!body || typeof body !== "object" || Array.isArray(body) || !bounded(body, 0)) {
    throw new IdentityValidationError("Invalid registration input.");
  }
  const input = {
    ...body,
    ...("identifier" in body && typeof body.identifier === "string" ? { identifier: body.identifier.trim() } : {}),
    ...("displayName" in body && typeof body.displayName === "string" ? { displayName: body.displayName.trim() } : {}),
  };
  return provider === "password" ? decodePasswordInput(input) : decodeGenericInput(input);
}

type NewIdentity = Pick<Account, "email" | "username" | "displayName" | "verified">;
interface PreparedEnrollment {
  readonly credential: PreparedCredential;
  readonly identity: NewIdentity;
}
interface EnrollmentResult {
  readonly account: Account;
  readonly credential: Credential;
  readonly session: IssuedSession;
}

const unavailable = () => new RegistrationError("RegistrationUnavailable", "Registration is temporarily unavailable.");
const closed = () => new RegistrationError("RegistrationClosed", "Registration is closed.");

function storageFailure(error: unknown): RegistrationError | RegistrationRateLimitError {
  const cause = unwrapFailure(error);
  return cause instanceof RegistrationError || cause instanceof RegistrationRateLimitError ? cause : unavailable();
}

function registrationSettings(control: RegistrationControl): RegistrationSettings {
  return { enabled: control.enabled, revision: control.revision };
}

/** The writable runtime may recompose its services while requests are in flight. */
export class RegistrationRecovery {
  private initialized?: Promise<void>;
  available = false;

  run(recover: Effect.Effect<void, RegistrationError | RegistrationRateLimitError>): Promise<void> {
    return this.initialized ??= present(recover.pipe(Effect.match({
      onSuccess: () => { this.available = true; },
      // The registration endpoints expose the redacted failure.
      onFailure: () => { this.available = false; },
    })));
  }
}

export class RegistrationService {
  private boundRuntime?: object;

  constructor(
    private readonly repositories: IdentityRepositories,
    private readonly accounts: AccountService,
    private readonly credentials: CredentialService,
    private readonly sessions: SessionService,
    private readonly providers: () => readonly CredentialProvider[],
    private options: RegistrationServiceOptions,
    private readonly recovery = new RegistrationRecovery(),
  ) {}

  /** Bind the authority of a mounted runtime, including a caller-supplied Identity. */
  bindRuntime(runtime: object, options: Partial<Omit<RegistrationServiceOptions, "now">>): void {
    if (this.boundRuntime && this.boundRuntime !== runtime) {
      throw new Error("Identity registration is already bound to a runtime.");
    }
    this.boundRuntime = runtime;
    this.options = { ...this.options, ...options };
  }

  /** Called during composition, after acquiring the runtime's writable state. */
  initialize(): Promise<void> {
    return this.recovery.run(Effect.gen({ self: this }, function* () {
      const control = yield* this.readControl();
      for (const slot of control.slots) {
        yield* (slot.phase === "committed" ? this.activate(slot) : this.rollback(slot));
        yield* this.retire(slot);
      }
    }));
  }

  settings(): Promise<RegistrationSettings> {
    return present(this.readControl().pipe(Effect.map(registrationSettings)));
  }

  setSettings(input: SetRegistrationSettingsInput): Promise<RegistrationSettings> {
    return present(Effect.gen({ self: this }, function* () {
      const parsed = yield* evaluate(() => decodeSetRegistrationSettingsInput(input)).pipe(
        Effect.mapError(() => new IdentityValidationError("Invalid registration settings.")),
      );
      const control = yield* this.mutateControl((current) => {
        const previous = current ?? this.initialControl();
        if (parsed.expectedRevision !== previous.revision) {
          throw new RegistrationError("RegistrationSettingsConflict", "Registration settings have changed.");
        }
        if (parsed.enabled === previous.enabled) return previous;
        if (previous.revision === Number.MAX_SAFE_INTEGER) throw unavailable();
        return { ...previous, enabled: parsed.enabled, revision: previous.revision + 1 };
      });
      return registrationSettings(control);
    }));
  }

  status(): Promise<RegistrationStatus> {
    return present(Effect.gen({ self: this }, function* () {
      if (!this.recovery.available) return yield* Effect.fail(unavailable());
      const control = yield* this.readControl();
      const enabled = control.enabled && (yield* this.enrollmentReady());
      return {
        enabled,
        providers: enabled
          ? this.providers().filter((provider) => provider.prepareCredential).map((provider) => provider.name).sort()
          : [],
      };
    }));
  }

  signUp(providerName: string, body: unknown): Promise<EnrollmentResult> {
    return present(Effect.gen({ self: this }, function* () {
      yield* this.requireOpen();
      const provider = this.providers().find((candidate) => candidate.name === providerName);
      const prepare = provider?.prepareCredential;
      if (!prepare) return yield* Effect.fail(new IdentityNotFoundError("Registration provider not found."));
      const input = yield* evaluate(() => decodeEnrollmentInput(providerName, body)).pipe(
        Effect.mapError(() => new IdentityValidationError("Invalid registration input.")),
      );
      return yield* this.enroll(providerName, "registration", () => integration(() =>
        prepare.call(provider, input),
      ).pipe(Effect.map((credential): PreparedEnrollment => ({
        credential,
        identity: {
          email: credential.accountIdentity?.email,
          username: credential.accountIdentity?.username,
          displayName: input.displayName,
          verified: false,
        },
      }))));
    }));
  }

  enrollPrepared(provider: string, identity: AuthorizationCodeIdentity): Promise<EnrollmentResult> {
    return present(Effect.gen({ self: this }, function* () {
      yield* this.requireOpen();
      return yield* this.enroll(provider, "authorization-code", () => Effect.succeed({
        credential: { identifier: identity.identifier, metadata: identity.metadata },
        identity: {
          email: identity.email,
          username: identity.username ?? (!identity.email ? `oidc_${crypto.randomUUID()}` : undefined),
          displayName: identity.displayName,
          verified: identity.verified === true,
        },
      }));
    }));
  }

  private initialControl(): RegistrationControl {
    return {
      id: "registration",
      schemaVersion: 1,
      enabled: this.options.initiallyEnabled,
      revision: 0,
      windowStartMs: 0,
      windowAttempts: 0,
      slots: [],
    };
  }

  private readControl() {
    return integration(() => this.repositories.registration.read()).pipe(
      Effect.flatMap((control) => evaluate(() => control === null ? this.initialControl() : decodeRegistrationControl(control))),
      Effect.mapError(storageFailure),
    );
  }

  private mutateControl(mutation: Mutation<RegistrationControl>) {
    return integration(() => this.repositories.registration.mutate((record) => {
      const current = record === null ? null : decodeRegistrationControl(record);
      const next = mutation(current);
      return next === current ? record : decodeRegistrationControl(next);
    })).pipe(
      Effect.flatMap((control) => evaluate(() => decodeRegistrationControl(control))),
      Effect.mapError(storageFailure),
    );
  }

  private enrollmentReady() {
    return integration(() => this.options.enrollmentReady()).pipe(Effect.mapError(storageFailure));
  }

  private requireOpen() {
    return Effect.gen({ self: this }, function* () {
      if (!this.recovery.available) return yield* Effect.fail(unavailable());
      const control = yield* this.readControl();
      if (!control.enabled || !(yield* this.enrollmentReady())) return yield* Effect.fail(closed());
    });
  }

  private reserve(slot: Pick<EnrollmentSlot, "accountId" | "credentialId">) {
    const nowMs = this.options.now().getTime();
    const minute = Math.floor(nowMs / REGISTRATION_WINDOW_MS) * REGISTRATION_WINDOW_MS;
    return this.mutateControl((current) => {
      const control = current ?? this.initialControl();
      if (!this.recovery.available) throw unavailable();
      if (!control.enabled) throw closed();
      const windowStartMs = Math.max(minute, control.windowStartMs);
      const attempts = windowStartMs === control.windowStartMs ? control.windowAttempts : 0;
      if (attempts >= REGISTRATION_ATTEMPT_LIMIT) {
        throw new RegistrationRateLimitError((windowStartMs + REGISTRATION_WINDOW_MS - nowMs) / 1000);
      }
      if (control.slots.length >= REGISTRATION_SLOT_LIMIT) {
        throw new RegistrationError("RegistrationBusy", "Registration is busy. Try again shortly.");
      }
      return {
        ...control,
        windowStartMs,
        windowAttempts: attempts + 1,
        slots: [...control.slots, { ...slot, policyRevision: control.revision, phase: "reserved" }],
      };
    });
  }

  private findSlot(control: RegistrationControl, ids: Pick<EnrollmentSlot, "accountId" | "credentialId">) {
    const slot = control.slots.find((entry) => entry.accountId === ids.accountId);
    if (slot && slot.credentialId !== ids.credentialId) throw unavailable();
    return slot;
  }

  private commit(slot: EnrollmentSlot) {
    return this.mutateControl((control) => {
      if (!this.recovery.available) throw unavailable();
      const reserved = control && this.findSlot(control, slot);
      if (!control || reserved?.phase !== "reserved" || reserved.policyRevision !== slot.policyRevision) throw unavailable();
      if (!control.enabled || control.revision !== slot.policyRevision) throw closed();
      return {
        ...control,
        slots: control.slots.map((entry) => entry.accountId === slot.accountId
          ? { ...entry, phase: "committed" }
          : entry),
      };
    });
  }

  private retire(slot: EnrollmentSlot) {
    return this.mutateControl((control) => {
      const stored = control && this.findSlot(control, slot);
      if (!control || stored?.phase !== slot.phase || stored.policyRevision !== slot.policyRevision) throw unavailable();
      return { ...control, slots: control.slots.filter((entry) => entry.accountId !== slot.accountId) };
    });
  }

  private activate(slot: EnrollmentSlot) {
    return Effect.gen({ self: this }, function* () {
      const credential = yield* integration(() => this.repositories.credentials.findById(slot.credentialId));
      if (credential?.accountId !== slot.accountId || credential.id !== slot.credentialId) {
        return yield* Effect.fail(unavailable());
      }
      const account = yield* integration(() => this.repositories.accounts.mutate(slot.accountId, (current) => {
        if (!current || current.id !== slot.accountId) throw unavailable();
        if (!current.registrationPending) return current;
        const { registrationPending: _pending, ...active } = current;
        return { ...active, updatedAt: this.options.now() };
      }));
      if (!account || account.registrationPending) return yield* Effect.fail(unavailable());
      return { account, credential };
    }).pipe(Effect.mapError(storageFailure));
  }

  private rollback(slot: EnrollmentSlot) {
    return Effect.gen({ self: this }, function* () {
      const account = yield* integration(() => this.repositories.accounts.findById(slot.accountId));
      if (account && (account.id !== slot.accountId || !account.registrationPending)) {
        return yield* Effect.fail(unavailable());
      }
      const credential = yield* integration(() => this.repositories.credentials.findById(slot.credentialId));
      if (credential && (credential.id !== slot.credentialId || credential.accountId !== slot.accountId)) {
        return yield* Effect.fail(unavailable());
      }
      if (credential && !(yield* integration(() => this.repositories.credentials.delete(credential.id)))) {
        return yield* Effect.fail(unavailable());
      }
      if (account && !(yield* integration(() => this.repositories.accounts.delete(account.id)))) {
        return yield* Effect.fail(unavailable());
      }
    }).pipe(Effect.mapError(storageFailure));
  }

  private stage(slot: EnrollmentSlot, provider: string, { credential, identity }: PreparedEnrollment) {
    return Effect.gen({ self: this }, function* () {
      const validate = (value: string | undefined, max: number) =>
        value === undefined || typeof value === "string" && value.trim().length > 0 && value.length <= max;
      if (!validate(credential.identifier, 4096) || !credential.identifier ||
          !validate(identity.email, 254) || !validate(identity.username, 254) ||
          !validate(identity.displayName, 120) ||
          !identity.email && !identity.username ||
          !validate(credential.secretHash, 4096)) {
        return yield* Effect.fail(new IdentityValidationError("Invalid prepared registration."));
      }
      const writeFailure = (failure: unknown) => unwrapFailure(failure) instanceof IdentityConflictError
        ? new RegistrationError("RegistrationConflict", "Unable to register this identity.")
        : unavailable();
      yield* integration(() => this.accounts.create({
        id: slot.accountId,
        email: identity.email,
        username: identity.username,
        displayName: identity.displayName?.trim(),
        verified: identity.verified === true,
        roles: [this.options.authority === "platform" ? "customer" : "user"],
        permissions: [],
        grants: [],
      }, { registrationPending: true })).pipe(Effect.mapError(writeFailure));
      yield* integration(() => this.credentials.create({
        id: slot.credentialId,
        accountId: slot.accountId,
        provider,
        identifier: credential.identifier,
        secretHash: credential.secretHash,
        metadata: credential.metadata,
      })).pipe(Effect.mapError(writeFailure));
    });
  }

  private enroll<E>(
    provider: string,
    authentication: "registration" | "authorization-code",
    prepare: () => Effect.Effect<PreparedEnrollment, E>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const ids = {
        accountId: `account_${crypto.randomUUID()}`,
        credentialId: `credential_${crypto.randomUUID()}`,
      };
      const committed = yield* Effect.gen({ self: this }, function* () {
        const control = yield* this.reserve(ids);
        const slot = this.findSlot(control, ids);
        if (!slot || slot.phase !== "reserved") return yield* Effect.fail(unavailable());
        const prepared = yield* prepare();
        yield* this.stage(slot, provider, prepared);
        yield* this.commit(slot);
        return { ...slot, phase: "committed" as const };
      }).pipe(Effect.catchCause((cause) => Effect.gen({ self: this }, function* () {
        const error = unwrapFailure(Cause.squash(cause));
        // An admission refusal cannot have written our slot. Other failures
        // may follow a durable write whose response was lost.
        if (error instanceof RegistrationRateLimitError ||
            error instanceof RegistrationError && error._tag === "RegistrationBusy") {
          return yield* Effect.fail(error);
        }
        const slot = yield* this.readControl().pipe(
          Effect.flatMap((control) => evaluate(() => this.findSlot(control, ids))),
          Effect.mapError(() => this.degrade()),
        );
        if (slot?.phase === "committed") return slot;
        if (slot) {
          yield* this.rollback(slot).pipe(
            Effect.andThen(this.retire(slot)),
            Effect.mapError(() => this.degrade()),
          );
        }
        if (error instanceof IdentityValidationError || error instanceof TypeError) {
          return yield* Effect.fail(new IdentityValidationError("Invalid registration input."));
        }
        return yield* Effect.fail(storageFailure(error));
      })));

      const active = yield* this.activate(committed).pipe(
        Effect.tap(() => this.retire(committed)),
        Effect.mapError(() => this.degrade()),
      );
      const session = yield* integration(() => this.sessions.create({
        accountId: active.account.id,
        expiresAt: new Date(this.options.now().getTime() + 30 * 24 * 60 * 60_000),
        metadata: { provider, authentication },
      })).pipe(Effect.mapError(() => unavailable()));
      return { ...active, session };
    }).pipe(Effect.uninterruptible);
  }

  private degrade(): RegistrationError {
    this.recovery.available = false;
    return unavailable();
  }
}
