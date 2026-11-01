import { Effect, Semaphore } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import {
  IdentityValidationError,
  type Account,
  type IdentityApi,
  type IdentityBootstrapCapability,
  type IdentityBootstrapInput,
  type IdentityBootstrapResult,
} from "../app/identity/index.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreRecord,
  ZelavisSystemStoreValue,
} from "../system-store.js";

const BOOTSTRAP_STATE_KEY = "zelavis.platform.bootstrapState";
const BOOTSTRAP_CLAIM_NAMESPACE = "zelavis.platform.auth.bootstrap";
const BOOTSTRAP_CLAIM_KEY = "first-owner";
const BOOTSTRAP_CLAIM_LEASE_MS = 5 * 60 * 1_000;

interface BootstrapClaim {
  claimId: string;
  status: "pending" | "complete" | "failed";
  createdAt: string;
  updatedAt: string;
}

function isPendingBootstrapAccount(account: Account): boolean {
  return account.metadata?.[BOOTSTRAP_STATE_KEY] === "pending";
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.randomUUID) {
    throw new IdentityValidationError(
      "Secure Web Crypto is required for Platform owner bootstrap.",
    );
  }
  return globalThis.crypto;
}

function normalizeOptional(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new IdentityValidationError("Bootstrap account fields must be strings.");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function createPlatformAuthBootstrap(
  auth: IdentityApi,
  options: { store?: ZelavisSystemStore } = {},
): IdentityBootstrapCapability {
  const bootstrapGate = Semaphore.makeUnsafe(1);

  function completedAccounts(): Promise<Account[]> {
    return present(Effect.gen(function* (): Effect.fn.Return<Account[], IntegrationFailure> {
    return (yield* integrationValue(((yield* integrationValue(auth.accounts.list()))).filter(
      (account) => !isPendingBootstrapAccount(account),
    )));
  }));
  }

  function cleanPendingAccounts(): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    const pending = ((yield* integrationValue(auth.accounts.list()))).filter(isPendingBootstrapAccount);
    for (const account of pending) {
      for (const session of (yield* integrationValue(auth.sessions.listByAccountId(account.id)))) {
        (yield* integrationValue(auth.repositories.sessions.delete(session.id)));
      }
      for (const credential of (yield* integrationValue(auth.credentials.listByAccountId(account.id)))) {
        (yield* integrationValue(auth.repositories.credentials.delete(credential.id)));
      }
      (yield* integrationValue(auth.repositories.accounts.delete(account.id)));
    }
  }));
  }

  function claimValue(claim: BootstrapClaim): ZelavisSystemStoreValue {
    return claim as unknown as ZelavisSystemStoreValue;
  }

  function readClaim(record: ZelavisSystemStoreRecord): BootstrapClaim | undefined {
    const value = record.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const claim = value as unknown as BootstrapClaim;
    return typeof claim.claimId === "string" &&
      (claim.status === "pending" || claim.status === "complete" || claim.status === "failed") &&
      typeof claim.createdAt === "string" &&
      typeof claim.updatedAt === "string"
      ? claim
      : undefined;
  }

  function acquireClaim(): Promise<ZelavisSystemStoreRecord | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisSystemStoreRecord | undefined, IntegrationFailure> {
    if (!options.store) return undefined;
    const now = new Date();
    const claim: BootstrapClaim = {
      claimId: requireCrypto().randomUUID(),
      status: "pending",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const created = (yield* integrationValue(options.store.setIfAbsent(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      claimValue(claim),
    )));
    if (created.created) return created.record;

    const existing = readClaim(created.record);
    if (!existing || existing.status === "complete") {
      throw new IdentityValidationError("Platform owner bootstrap is already complete.");
    }
    const leaseAge = now.getTime() - new Date(existing.updatedAt).getTime();
    if (existing.status === "pending" && leaseAge < BOOTSTRAP_CLAIM_LEASE_MS) {
      throw new IdentityValidationError("Platform owner bootstrap is already in progress.");
    }
    const replaced = (yield* integrationValue(options.store.compareAndSet(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      created.record.updatedAt,
      claimValue(claim),
    )));
    if (!replaced) {
      throw new IdentityValidationError("Platform owner bootstrap is already in progress.");
    }
    return replaced;
  }));
  }

  function finishClaim(
    record: ZelavisSystemStoreRecord | undefined,
    status: "complete" | "failed",
  ): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    if (!options.store || !record) return;
    const current = readClaim(record);
    if (!current) return;
    (yield* integrationValue(options.store.compareAndSet(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      record.updatedAt,
      claimValue({
        ...current,
        status,
        updatedAt: new Date().toISOString(),
      }),
    )));
  }));
  }

  return {
    status() {
    return present(Effect.gen(function* () {
      return {
        required: ((yield* integrationValue(completedAccounts()))).length === 0,
        providers: auth.authentication.listProviders(),
        enrollmentProviders: auth.authentication.listEnrollmentProviders(),
      };
    }));
  },

    bootstrap(input: IdentityBootstrapInput): Promise<IdentityBootstrapResult> {
      return present(bootstrapGate.withPermit(Effect.gen(function* (): Effect.fn.Return<IdentityBootstrapResult, IntegrationFailure> {
        if ((yield* integrationValue(completedAccounts())).length > 0) {
          throw new IdentityValidationError(
            "Platform owner bootstrap is already complete.",
          );
        }

        if (!input || typeof input !== "object") {
          throw new IdentityValidationError("Platform owner bootstrap input is required.");
        }
        if (!input.provider || typeof input.provider !== "string") {
          throw new IdentityValidationError(
            "Platform owner bootstrap requires an authentication provider.",
          );
        }
        if (!input.account || typeof input.account !== "object") {
          throw new IdentityValidationError(
            "Platform owner bootstrap requires account details.",
          );
        }
        if (!input.credential || typeof input.credential !== "object") {
          throw new IdentityValidationError(
            "Platform owner bootstrap requires credential details.",
          );
        }

        const prepared = yield* integrationValue(auth.authentication.prepareCredential(
          input.provider,
          input.credential,
        ));
        const email = prepared.accountIdentity?.email ?? normalizeOptional(input.account.email)?.toLowerCase();
        const username = prepared.accountIdentity?.username ?? normalizeOptional(input.account.username);
        const requestedEmail = normalizeOptional(input.account.email)?.toLowerCase();
        const requestedUsername = normalizeOptional(input.account.username);
        if (prepared.accountIdentity?.email && requestedEmail && prepared.accountIdentity.email !== requestedEmail) {
          throw new IdentityValidationError(
            "The bootstrap email must match the enrolled credential identifier.",
          );
        }
        if (prepared.accountIdentity?.username && requestedUsername && prepared.accountIdentity.username !== requestedUsername) {
          throw new IdentityValidationError(
            "The bootstrap username must match the enrolled credential identifier.",
          );
        }
        if (!email && !username) {
          throw new IdentityValidationError(
            "Platform owner bootstrap requires an email or username identity.",
          );
        }

        const claim = yield* integrationValue(acquireClaim());
        const crypto = requireCrypto();
        const accountId = `account_${crypto.randomUUID()}`;
        const credentialId = `credential_${crypto.randomUUID()}`;
        let account: Account | undefined;
        let sessionId: string | undefined;

        return yield* Effect.gen(function* () {
          yield* integrationValue(cleanPendingAccounts());
          account = yield* integrationValue(auth.accounts.create({
            id: accountId,
            email,
            username,
            displayName: normalizeOptional(input.account.displayName),
            roles: ["owner"],
            permissions: ["*"],
            metadata: { [BOOTSTRAP_STATE_KEY]: "pending" },
          }));
          yield* integrationValue(auth.credentials.create({
            id: credentialId,
            accountId,
            provider: input.provider,
            identifier: prepared.identifier,
            secretHash: prepared.secretHash,
            metadata: prepared.metadata,
          }));
          const { [BOOTSTRAP_STATE_KEY]: _state, ...metadata } = account.metadata ?? {};
          account = yield* integrationValue(auth.repositories.accounts.update({
            ...account,
            metadata: Object.keys(metadata).length ? metadata : undefined,
            updatedAt: new Date(),
          }));
          const session = yield* integrationValue(auth.sessions.create({
            accountId,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
            metadata: { provider: input.provider, bootstrap: true },
          }));
          sessionId = session.session.id;
          yield* integrationValue(finishClaim(claim, "complete"));
          return { account, session };
        }).pipe(Effect.onError(() => Effect.gen(function* () {
          if (sessionId) yield* integrationValue(auth.repositories.sessions.delete(sessionId));
          yield* integrationValue(auth.repositories.credentials.delete(credentialId));
          if (account) yield* integrationValue(auth.repositories.accounts.delete(accountId));
          yield* integrationValue(finishClaim(claim, "failed"));
        }).pipe(Effect.orDie)));
      })));
    },
  };
}
