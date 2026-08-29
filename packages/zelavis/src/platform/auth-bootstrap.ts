import {
  AuthValidationError,
  type Account,
  type AuthApi,
  type AuthBootstrapCapability,
  type AuthBootstrapInput,
  type AuthBootstrapResult,
} from "../app/auth/index.js";
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
    throw new AuthValidationError(
      "Secure Web Crypto is required for Platform owner bootstrap.",
    );
  }
  return globalThis.crypto;
}

function normalizeOptional(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AuthValidationError("Bootstrap account fields must be strings.");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function createPlatformAuthBootstrap(
  auth: AuthApi,
  options: { store?: ZelavisSystemStore } = {},
): AuthBootstrapCapability {
  let operationTail: Promise<void> = Promise.resolve();

  async function completedAccounts(): Promise<Account[]> {
    return (await auth.accounts.list()).filter(
      (account) => !isPendingBootstrapAccount(account),
    );
  }

  async function cleanPendingAccounts(): Promise<void> {
    const pending = (await auth.accounts.list()).filter(isPendingBootstrapAccount);
    for (const account of pending) {
      for (const session of await auth.sessions.listByAccountId(account.id)) {
        await auth.repositories.sessions.delete(session.id);
      }
      for (const credential of await auth.credentials.listByAccountId(account.id)) {
        await auth.repositories.credentials.delete(credential.id);
      }
      await auth.repositories.accounts.delete(account.id);
    }
  }

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

  async function acquireClaim(): Promise<ZelavisSystemStoreRecord | undefined> {
    if (!options.store) return undefined;
    const now = new Date();
    const claim: BootstrapClaim = {
      claimId: requireCrypto().randomUUID(),
      status: "pending",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const created = await options.store.setIfAbsent(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      claimValue(claim),
    );
    if (created.created) return created.record;

    const existing = readClaim(created.record);
    if (!existing || existing.status === "complete") {
      throw new AuthValidationError("Platform owner bootstrap is already complete.");
    }
    const leaseAge = now.getTime() - new Date(existing.updatedAt).getTime();
    if (existing.status === "pending" && leaseAge < BOOTSTRAP_CLAIM_LEASE_MS) {
      throw new AuthValidationError("Platform owner bootstrap is already in progress.");
    }
    const replaced = await options.store.compareAndSet(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      created.record.updatedAt,
      claimValue(claim),
    );
    if (!replaced) {
      throw new AuthValidationError("Platform owner bootstrap is already in progress.");
    }
    return replaced;
  }

  async function finishClaim(
    record: ZelavisSystemStoreRecord | undefined,
    status: "complete" | "failed",
  ): Promise<void> {
    if (!options.store || !record) return;
    const current = readClaim(record);
    if (!current) return;
    await options.store.compareAndSet(
      BOOTSTRAP_CLAIM_NAMESPACE,
      BOOTSTRAP_CLAIM_KEY,
      record.updatedAt,
      claimValue({
        ...current,
        status,
        updatedAt: new Date().toISOString(),
      }),
    );
  }

  return {
    async status() {
      return {
        required: (await completedAccounts()).length === 0,
        providers: auth.authentication.listProviders(),
        enrollmentProviders: auth.authentication.listEnrollmentProviders(),
      };
    },

    bootstrap(input: AuthBootstrapInput): Promise<AuthBootstrapResult> {
      return serialize(async () => {
        if ((await completedAccounts()).length > 0) {
          throw new AuthValidationError(
            "Platform owner bootstrap is already complete.",
          );
        }

        if (!input || typeof input !== "object") {
          throw new AuthValidationError("Platform owner bootstrap input is required.");
        }
        if (!input.provider || typeof input.provider !== "string") {
          throw new AuthValidationError(
            "Platform owner bootstrap requires an authentication provider.",
          );
        }
        if (!input.account || typeof input.account !== "object") {
          throw new AuthValidationError(
            "Platform owner bootstrap requires account details.",
          );
        }
        if (!input.credential || typeof input.credential !== "object") {
          throw new AuthValidationError(
            "Platform owner bootstrap requires credential details.",
          );
        }

        const prepared = await auth.authentication.prepareCredential(
          input.provider,
          input.credential,
        );
        const email = prepared.accountIdentity?.email ?? normalizeOptional(input.account.email)?.toLowerCase();
        const username = prepared.accountIdentity?.username ?? normalizeOptional(input.account.username);
        const requestedEmail = normalizeOptional(input.account.email)?.toLowerCase();
        const requestedUsername = normalizeOptional(input.account.username);
        if (prepared.accountIdentity?.email && requestedEmail && prepared.accountIdentity.email !== requestedEmail) {
          throw new AuthValidationError(
            "The bootstrap email must match the enrolled credential identifier.",
          );
        }
        if (prepared.accountIdentity?.username && requestedUsername && prepared.accountIdentity.username !== requestedUsername) {
          throw new AuthValidationError(
            "The bootstrap username must match the enrolled credential identifier.",
          );
        }
        if (!email && !username) {
          throw new AuthValidationError(
            "Platform owner bootstrap requires an email or username identity.",
          );
        }

        const claim = await acquireClaim();
        const crypto = requireCrypto();
        const accountId = `account_${crypto.randomUUID()}`;
        const credentialId = `credential_${crypto.randomUUID()}`;
        let account: Account | undefined;
        let sessionId: string | undefined;

        try {
          await cleanPendingAccounts();
          account = await auth.accounts.create({
            id: accountId,
            email,
            username,
            displayName: normalizeOptional(input.account.displayName),
            roles: ["owner"],
            permissions: ["*"],
            metadata: { [BOOTSTRAP_STATE_KEY]: "pending" },
          });
          await auth.credentials.create({
            id: credentialId,
            accountId,
            provider: input.provider,
            identifier: prepared.identifier,
            secretHash: prepared.secretHash,
            metadata: prepared.metadata,
          });
          const { [BOOTSTRAP_STATE_KEY]: _state, ...metadata } = account.metadata ?? {};
          account = await auth.repositories.accounts.update({
            ...account,
            metadata: Object.keys(metadata).length ? metadata : undefined,
            updatedAt: new Date(),
          });
          const session = await auth.sessions.create({
            accountId,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
            metadata: { provider: input.provider, bootstrap: true },
          });
          sessionId = session.session.id;
          await finishClaim(claim, "complete");
          return { account, session };
        } catch (error) {
          if (sessionId) await auth.repositories.sessions.delete(sessionId);
          await auth.repositories.credentials.delete(credentialId);
          if (account) await auth.repositories.accounts.delete(accountId);
          await finishClaim(claim, "failed");
          throw error;
        }
      });
    },
  };
}
