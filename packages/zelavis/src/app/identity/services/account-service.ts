import { Effect, Option, Semaphore } from "effect";
import { evaluate, present, integration, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import type { AccountRepository, AuthSecurityEventRepository } from "../contracts/repositories.js";
import type { Account } from "../domain/entities.js";
import type { ZelavisAccessScope, ZelavisPrincipal, ZelavisPrincipalGrant } from "../../../core/index.js";
import { principalHasPermission } from "../../../core/runtime/request-dispatcher.js";
import { AccountAccessError, IdentityValidationError } from "../core/errors.js";
import { accountSessionPrincipal, accountSessionProof } from "../core/session-authenticator.js";
import {
  accountGrantKey,
  decodeSetAccountAccessInput,
  isConcreteScope,
  normalizeAccountAccess,
  projectAccountAccessDigest,
  projectAccountAccessPermissions,
  projectAccountAccessProof,
  type AccountAccessResult,
  type ConcreteAccountGrant,
} from "../domain/account-access.js";

export interface CreateAccountInput {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified?: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly ZelavisPrincipalGrant[];
  metadata?: Record<string, unknown>;
}

function activeAccount(account: Account | null): Account | null {
  return account?.registrationPending ? null : account;
}

export type AccountAdministrationContext = {
  readonly principal: ZelavisPrincipal | undefined;
} & ({
  readonly authority: "platform";
  readonly validateGrantScopes?: (scopes: readonly ConcreteAccountGrant["scope"][]) => Promise<boolean>;
} | { readonly authority: "project"; readonly projectId?: string });

type AccountAuthority = Pick<Account, "roles" | "permissions" | "grants">;

export function accountAccessForbidden(): AccountAccessError {
  return new AccountAccessError("AccountAccessForbidden", "The caller cannot delegate this account access.");
}

export function accountNotFound(): AccountAccessError {
  return new AccountAccessError("AccountNotFound", "Account not found.");
}

const reservedAccountMetadata = new Set([
  "principalType", "serviceAccount", "tenantId", "registrationPending",
  "authenticationTransport", "sessionId", "authority", "projectId", "platformScopeId",
  "placementGeneration", "runtimeNodeId",
]);

export function hasReservedAccountMetadata(metadata: Record<string, unknown>): boolean {
  return Object.keys(metadata).some((key) => reservedAccountMetadata.has(key));
}

export function isServiceAccount(account: Account): boolean {
  return account.metadata?.principalType === "service" || account.metadata?.serviceAccount === true ||
    account.roles?.includes("service") === true;
}

function canDelegateRole(actor: ZelavisPrincipal, role: string): boolean {
  return role === "customer" || role === "user" ||
    actor.permissions?.includes("*") === true || actor.roles?.includes(role) === true;
}

/** Evaluate stored and proposed authority with the same scope rules as request dispatch. */
export function assertCanDelegateAccountAccess(
  actor: ZelavisPrincipal,
  context: AccountAdministrationContext,
  access: AccountAuthority,
  provedProjectPermissions?: readonly string[],
): void {
  const projectScope = context.authority === "project" && context.projectId
    ? { type: "project" as const, projectId: context.projectId }
    : undefined;
  if (context.authority === "project" && !projectScope && access.grants?.length) {
    throw accountAccessForbidden();
  }
  for (const role of access.roles ?? []) {
    if (!canDelegateRole(actor, role)) throw accountAccessForbidden();
  }
  for (const permission of access.permissions ?? []) {
    if (context.authority === "platform") {
      if (!actor.permissions?.includes(permission) && !actor.permissions?.includes("*")) {
        throw accountAccessForbidden();
      }
    } else if (!(provedProjectPermissions?.includes(permission) ?? principalHasPermission(actor, permission, projectScope))) {
      throw accountAccessForbidden();
    }
  }
  for (const { permission, scope } of access.grants ?? []) {
    if ((scope && !isConcreteScope(scope)) ||
        (projectScope && (scope?.type !== "project" || scope.projectId !== projectScope.projectId)) ||
        !(provedProjectPermissions?.includes(permission) ?? principalHasPermission(actor, permission, scope))) {
      throw accountAccessForbidden();
    }
  }
}

const accessGates = new WeakMap<object, {
  readonly admission: Semaphore.Semaphore;
  readonly writer: Semaphore.Semaphore;
}>();
const ACCOUNT_ADMINISTRATION_LIMIT = 32;

function accessGate(owner: object) {
  const existing = accessGates.get(owner);
  if (existing) return existing;
  const gate = {
    admission: Semaphore.makeUnsafe(ACCOUNT_ADMINISTRATION_LIMIT),
    writer: Semaphore.makeUnsafe(1),
  };
  accessGates.set(owner, gate);
  return gate;
}

export class AccountService {
  private readonly gate: ReturnType<typeof accessGate>;

  constructor(
    private readonly repository: AccountRepository,
    private readonly securityEvents: AuthSecurityEventRepository,
    writer: object = repository,
  ) {
    this.gate = accessGate(writer);
  }

  administer<A, E>(
    context: AccountAdministrationContext,
    operation: (actor: ZelavisPrincipal) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | IntegrationFailure | AccountAccessError> {
    const self = this;
    const program = Effect.gen(function* () {
      const principal = context.principal;
      if (!principal || principal.type === "anonymous") return yield* Effect.fail(accountAccessForbidden());
      const proof = accountSessionProof(principal);
      let actor = principal;
      if (proof) {
        const account = yield* integration(() => self.repository.findById(principal.id));
        if (!account || account.registrationPending || (account.sessionEpoch ?? 0) !== proof.epoch) {
          return yield* Effect.fail(accountAccessForbidden());
        }
        actor = accountSessionPrincipal(
          account,
          typeof principal.metadata?.sessionId === "string" ? principal.metadata.sessionId : "",
          principal.metadata?.authenticationTransport === "cookie" ? "cookie" : "bearer",
          context.authority === "project" ? context.projectId : undefined,
        );
      }
      const scope: ZelavisAccessScope | undefined = context.authority === "platform" ? { type: "system" }
        : context.projectId ? { type: "project", projectId: context.projectId } : undefined;
      const permission = context.authority === "platform" ? "system.users.manage" : "project.users.manage";
      if (!principalHasPermission(actor, permission, scope)) return yield* Effect.fail(accountAccessForbidden());
      return yield* operation(actor);
    });
    return this.gate.admission.withPermitsIfAvailable(1)(this.gate.writer.withPermit(program)).pipe(
      Effect.flatMap((result) => Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(new AccountAccessError("AccountAccessBusy", "Account administration is busy. Try again later."))),
    );
  }

  setAccess(accountId: string, body: unknown, context: AccountAdministrationContext): Promise<AccountAccessResult> {
    const self = this;
    return present(Effect.gen(function* () {
      const input = yield* evaluate(() => normalizeAccountAccess(decodeSetAccountAccessInput(body))).pipe(
        Effect.mapError(() => new AccountAccessError("InvalidAccountAccess", "Invalid account access.")),
      );
      if (context.authority === "project" ? input.role !== "user" || input.permissions.length !== 0 ||
        !context.projectId || input.grants.some(({ scope }) => scope.type !== "project" || scope.projectId !== context.projectId)
        : input.role === "user") {
        return yield* Effect.fail(accountAccessForbidden());
      }
      return yield* self.administer(context, (actor) => Effect.gen(function* () {
        const proof = projectAccountAccessProof(actor);
        let provedProjectPermissions: readonly string[] | undefined;
        if (proof) {
          if (!proof.digest || context.authority !== "project" || !context.projectId) {
            return yield* Effect.fail(accountAccessForbidden());
          }
          const projectId = context.projectId;
          const current = yield* integration(() => self.findById(accountId));
          if (!current) return yield* Effect.fail(accountNotFound());
          if ((current.accessRevision ?? 0) !== input.expectedRevision) {
            return yield* Effect.fail(new AccountAccessError("AccountAccessConflict", "The account access revision has changed."));
          }
          const permissions = projectAccountAccessPermissions(projectId, current, input);
          if (!permissions || (yield* projectAccountAccessDigest(accountId, input, permissions)) !== proof.digest) {
            return yield* Effect.fail(accountAccessForbidden());
          }
          provedProjectPermissions = permissions;
        }
        if (context.authority === "platform" && context.validateGrantScopes && input.grants.length > 0) {
          const validateGrantScopes = context.validateGrantScopes;
          yield* evaluate(() => assertCanDelegateAccountAccess(actor, context, { ...input, roles: [input.role] }));
          const current = yield* integration(() => self.findById(accountId));
          if (!current) return yield* Effect.fail(accountNotFound());
          const existing = new Set((current.grants ?? []).map(accountGrantKey));
          const added = input.grants.filter((grant) => !existing.has(accountGrantKey(grant))).map(({ scope }) => scope);
          if ((current.accessRevision ?? 0) !== input.expectedRevision) {
            return yield* Effect.fail(new AccountAccessError("AccountAccessConflict", "The account access revision has changed."));
          }
          if (added.length > 0 && !(yield* integration(() => validateGrantScopes(added)))) {
            return yield* Effect.fail(new AccountAccessError("InvalidAccountAccess", "New account grants must name existing Projects or installed services."));
          }
        }
        const now = new Date();
        const updated = yield* integration(() => self.repository.mutate(accountId, (current) => {
          if (!current || current.id !== accountId || current.registrationPending) throw accountNotFound();
          if (current.id === actor.id ||
              current.roles?.some((role) => ["owner", "service", "system"].includes(role)) ||
              isServiceAccount(current) || current.metadata?.principalType === "system") {
            throw accountAccessForbidden();
          }
          const revision = current.accessRevision ?? 0;
          const epoch = current.sessionEpoch ?? 0;
          if (!Number.isSafeInteger(revision) || revision < 0 || revision !== input.expectedRevision) {
            throw new AccountAccessError("AccountAccessConflict", "The account access revision has changed.");
          }
          if (!Number.isSafeInteger(epoch) || epoch < 0) {
            throw new AccountAccessError("AccountAccessConflict", "The account session revision is invalid.");
          }
          assertCanDelegateAccountAccess(actor, context, current, provedProjectPermissions);
          assertCanDelegateAccountAccess(actor, context, { ...input, roles: [input.role] }, provedProjectPermissions);
          const same = current.roles?.length === 1 && current.roles[0] === input.role &&
            JSON.stringify([...new Set(current.permissions ?? [])].sort()) === JSON.stringify(input.permissions) &&
            JSON.stringify([...new Set((current.grants ?? []).map(accountGrantKey))].sort()) ===
              JSON.stringify(input.grants.map(accountGrantKey));
          if (same) return current;
          if (revision === Number.MAX_SAFE_INTEGER || epoch === Number.MAX_SAFE_INTEGER) {
            throw new AccountAccessError("AccountAccessConflict", "Account access or session revision is exhausted.");
          }
          return {
            ...current,
            roles: [input.role],
            permissions: input.permissions,
            grants: input.grants,
            accessRevision: revision + 1,
            sessionEpoch: epoch + 1,
            updatedAt: now,
          };
        }));
        if (!updated) return yield* Effect.fail(accountNotFound());
        const accessRevision = updated.accessRevision ?? 0;
        if (accessRevision !== input.expectedRevision) {
          yield* integration(() => self.securityEvents.append({
            id: `security_event_${crypto.randomUUID()}`,
            type: "account.access.changed",
            actorId: actor.id,
            accountId: updated.id,
            accessRevision,
            occurredAt: now,
          })).pipe(Effect.mapError(() => new AccountAccessError(
            "AccountAccessAuditFailed", "Account access changed, but the security event could not be recorded.", accessRevision,
          )));
        }
        return {
          accountId: updated.id,
          accessRevision,
          role: input.role,
          permissions: [...input.permissions],
          grants: input.grants.map((grant) => ({ permission: grant.permission, scope: { ...grant.scope } })),
        };
      }));
    }));
  }

  create(input: CreateAccountInput, options?: { registrationPending: true }): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account, IntegrationFailure> {
    if (!input.id) {
      throw new IdentityValidationError("Account creation requires an id.");
    }

    const email = input.email?.trim().toLowerCase();
    const username = input.username?.trim();
    if (!email && !username) {
      throw new IdentityValidationError(
        "Account creation requires at least an email or username.",
      );
    }

    // No look-before-write: two callers can both find nothing. The repository
    // enforces uniqueness atomically and throws `IdentityConflictError`.
    const now = new Date();
    return (yield* integrationValue(self.repository.create({
      ...input,
      email,
      username,
      verified: input.verified ?? false,
      registrationPending: options?.registrationPending,
      createdAt: now,
      updatedAt: now,
    })));
  }));
  }

  findById(id: string): Promise<Account | null> {
    return present(integration(() => this.repository.findById(id)).pipe(Effect.map(activeAccount)));
  }

  delete(id: string): Promise<boolean> {
    return present(Effect.gen({ self: this }, function* () {
      const account = yield* integration(() => this.findById(id));
      return account ? yield* integration(() => this.repository.delete(id)) : false;
    }));
  }

  findByEmail(email: string): Promise<Account | null> {
    return present(integration(() => this.repository.findByEmail(email.trim().toLowerCase())).pipe(Effect.map(activeAccount)));
  }

  findByUsername(username: string): Promise<Account | null> {
    return present(integration(() => this.repository.findByUsername(username.trim())).pipe(Effect.map(activeAccount)));
  }

  list(): Promise<Account[]> {
    return present(integration(() => this.repository.list()).pipe(
      Effect.map((accounts) => accounts.filter((account) => !account.registrationPending)),
    ));
  }

  /**
   * Replaces an account's metadata.
   *
   * Whole-record rather than a merge, so the caller decides what survives: a
   * merge here would make removing a key impossible without a second
   * operation, and metadata is where authority-adjacent facts like the
   * Tenant live.
   */
  setMetadata(id: string, metadata: Record<string, unknown>): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* () {
      const updatedAt = new Date();
      const account = yield* integration(() => self.repository.mutate(id, (current) => {
        if (!current || current.registrationPending) throw accountNotFound();
        return { ...current, metadata, updatedAt };
      }));
      if (!account) return yield* Effect.fail(accountNotFound());
      return account;
    }));
  }
}
