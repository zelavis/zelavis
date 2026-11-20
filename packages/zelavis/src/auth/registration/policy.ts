/**
 * The registration policy (Zelavis-own, moved from Identity's
 * `domain/registration.ts` and `RegistrationService`): whether this runtime
 * admits sign-ups, and how fast.
 *
 * Every sign-up of every method runs `admit` inside the transaction that
 * creates the account (the core's `completeSignUp` and `signUpWithoutSession`),
 * so a closed runtime refuses it and nothing it wrote commits; open, the
 * account and its credential are one commit and no half-created account can
 * exist. That is why Identity's enrollment slots and pending-account recovery
 * are not carried: they repaired a state this cannot reach.
 *
 * Open means the saved setting is on and, on the Platform, the first owner
 * exists (until then the bootstrap claim is the only way in). Admission takes
 * a token from two buckets: one per client address (10 an hour) and one for
 * the runtime (60 a minute); a call with no client address takes only the
 * second. Bootstrap, administrator creation, import and
 * invitations create accounts with `createAdmittedAccount`, which no gate
 * stops.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { TransactionTooLarge } from "../../db/errors.js";
import { bootstrapTables } from "../bootstrap/tables.js";
import { type AuthTxBase, HOUR, defineRateLimits } from "../runtime/index.js";
import { RegistrationClosed, RegistrationRateLimited } from "./errors.js";
import { registrationTables } from "./tables.js";

export const REGISTRATION_ATTEMPT_LIMIT = 60;
export const REGISTRATION_WINDOW_MS = 60_000;
/** Sign-ups one client address may make an hour. */
export const REGISTRATION_CLIENT_LIMIT = 10;
export const REGISTRATION_SETTINGS_BODY_BYTES = 1024;

export const RegistrationSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  revision: Schema.Natural,
});
export type RegistrationSettings = typeof RegistrationSettingsSchema.Type;

export const SetRegistrationSettingsInputSchema = Schema.Struct({
  enabled: Schema.Boolean,
  expectedRevision: Schema.Natural,
});
export type SetRegistrationSettingsInput = typeof SetRegistrationSettingsInputSchema.Type;
/** Decodes a registration settings change (CLI `--data`), refusing fields it does not know. */
export const decodeSetRegistrationSettingsInput = Schema.decodeUnknownSync(SetRegistrationSettingsInputSchema, { onExcessProperty: "error" });

export const RegistrationStatusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  providers: Schema.Array(Schema.String),
});
export type RegistrationStatus = typeof RegistrationStatusSchema.Type;

export const registrationSettingsJsonSchema = Schema.toJsonSchemaDocument(RegistrationSettingsSchema).schema;
export const registrationStatusJsonSchema = Schema.toJsonSchemaDocument(RegistrationStatusSchema).schema;
export const registrationSettingsInputJsonSchema = Schema.toJsonSchemaDocument(
  SetRegistrationSettingsInputSchema,
  { onExcessProperty: "error" },
).schema;

const limits = defineRateLimits("registration", {
  client: { kind: "token bucket", rate: REGISTRATION_CLIENT_LIMIT, period: HOUR },
  runtime: { kind: "token bucket", rate: REGISTRATION_ATTEMPT_LIMIT, period: REGISTRATION_WINDOW_MS },
  passwordClient: { kind: "token bucket", rate: REGISTRATION_CLIENT_LIMIT, period: HOUR },
  passwordRuntime: { kind: "token bucket", rate: REGISTRATION_ATTEMPT_LIMIT, period: REGISTRATION_WINDOW_MS },
});

// A runtime-wide bucket under one fixed key: sign-up is creation, not redemption, so I6 allows it.
const RUNTIME_KEY = "runtime";

export interface RegistrationOptions {
  readonly role: "platform" | "project";
  /** The setting before anyone saved one. */
  readonly initiallyEnabled: boolean;
}

export interface Registration {
  readonly settings: (tx: AuthTxBase) => Effect.Effect<RegistrationSettings, TransactionTooLarge>;
  /** Change the setting when `expectedRevision` is current; a stale one answers `conflict` and writes nothing. */
  readonly setSettings: (tx: AuthTxBase, input: SetRegistrationSettingsInput) => Effect.Effect<
    { readonly success: true; readonly settings: RegistrationSettings; readonly changed: boolean } | { readonly success: false; readonly conflict: RegistrationSettings },
    TransactionTooLarge
  >;
  /** Whether a sign-up would be admitted now, rate limits aside. */
  readonly isOpen: (tx: AuthTxBase) => Effect.Effect<boolean, TransactionTooLarge>;
  /** Fail with `RegistrationClosed` unless open; consumes nothing. */
  readonly check: (tx: AuthTxBase) => Effect.Effect<void, RegistrationClosed | TransactionTooLarge>;
  /** Admit one sign-up: open, and a token from both buckets. Consumed with the sign-up's own commit. */
  readonly admit: (tx: AuthTxBase) => Effect.Effect<void, RegistrationClosed | RegistrationRateLimited | TransactionTooLarge>;
  /** Admission for password hashing. Commits before hashing, including when the sign-up later fails. */
  readonly admitPasswordAttempt: (tx: AuthTxBase) => Effect.Effect<void, RegistrationClosed | RegistrationRateLimited | TransactionTooLarge>;
}

export function createRegistration(options: RegistrationOptions): Registration {
  const initial: RegistrationSettings = { enabled: options.initiallyEnabled, revision: 0 };
  const row = (tx: AuthTxBase) => tx.db.query(registrationTables.policy).unique();

  const settings = (tx: AuthTxBase) =>
    Effect.map(row(tx), (current) => current === null ? initial : { enabled: current.enabled, revision: current.revision });

  const setSettings = Effect.fn("auth.registration.setSettings")(function* (tx: AuthTxBase, input: SetRegistrationSettingsInput) {
    const current = yield* row(tx);
    const previous = current === null ? initial : { enabled: current.enabled, revision: current.revision };
    if (previous.revision !== input.expectedRevision) return { success: false, conflict: previous } as const;
    if (previous.enabled === input.enabled) return { success: true, settings: previous, changed: false } as const;
    const next = { enabled: input.enabled, revision: previous.revision + 1 };
    if (current === null) yield* tx.db.insert(registrationTables.policy, next);
    else yield* tx.db.replace(registrationTables.policy, current._id, next);
    return { success: true, settings: next, changed: true } as const;
  });

  const isOpen = Effect.fn("auth.registration.isOpen")(function* (tx: AuthTxBase) {
    if (!(yield* settings(tx)).enabled) return false;
    // On the Platform nobody signs up before the first owner exists.
    if (options.role === "platform" && (yield* tx.db.query(bootstrapTables.claims).first()) === null) return false;
    return true;
  });

  const check = Effect.fn("auth.registration.check")(function* (tx: AuthTxBase) {
    if (!(yield* isOpen(tx))) return yield* Effect.fail(new RegistrationClosed());
  });

  const charge = Effect.fn("auth.registration.charge")(function* (
    tx: AuthTxBase,
    clientBucket: "client" | "passwordClient",
    runtimeBucket: "runtime" | "passwordRuntime",
  ) {
    yield* check(tx);
    // A call with no client address (in-process, no listener) is limited by the runtime bucket alone.
    if (tx.request.ip !== null) {
      const perClient = yield* limits.limit(tx, clientBucket, { key: tx.request.ip });
      if (!perClient.ok) return yield* Effect.fail(new RegistrationRateLimited({ retryAfterMs: perClient.retryAfter }));
    }
    const perRuntime = yield* limits.limit(tx, runtimeBucket, { key: RUNTIME_KEY });
    if (!perRuntime.ok) return yield* Effect.fail(new RegistrationRateLimited({ retryAfterMs: perRuntime.retryAfter }));
  });

  return {
    settings, setSettings, isOpen, check,
    admit: (tx) => charge(tx, "client", "runtime"),
    admitPasswordAttempt: (tx) => charge(tx, "passwordClient", "passwordRuntime"),
  };
}
