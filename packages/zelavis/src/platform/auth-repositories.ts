import type {
  Account,
  AccountRepository,
  AuthAttemptState,
  AuthAttemptRepository,
  AuthAuthorizationFlow,
  AuthAuthorizationFlowRepository,
  AuthRepositories,
  AuthSecurityEvent,
  AuthSecurityEventRepository,
  Credential,
  CredentialRepository,
  Session,
  SessionRepository,
} from "../app/auth/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "zelavis.platform.auth";

type StoredEntity = Record<string, ZelavisSystemStoreValue>;

function storeValue(entity: unknown): StoredEntity {
  return JSON.parse(JSON.stringify(entity)) as StoredEntity;
}

function revive<T extends Account | Credential | Session>(value: ZelavisSystemStoreValue): T {
  const entity = value as unknown as T & { createdAt: string; updatedAt: string; expiresAt?: string };
  return {
    ...entity,
    createdAt: new Date(entity.createdAt),
    updatedAt: new Date(entity.updatedAt),
    ...("expiresAt" in entity ? { expiresAt: new Date(entity.expiresAt as string) } : {}),
  } as T;
}

function reviveAttempt(value: ZelavisSystemStoreValue): AuthAttemptState {
  const state = value as unknown as Omit<AuthAttemptState, "failures" | "blockedUntil" | "updatedAt"> & {
    failures: string[];
    blockedUntil?: string;
    updatedAt: string;
  };
  return {
    ...state,
    failures: state.failures.map((failure) => new Date(failure)),
    blockedUntil: state.blockedUntil ? new Date(state.blockedUntil) : undefined,
    updatedAt: new Date(state.updatedAt),
  };
}

function reviveSecurityEvent(value: ZelavisSystemStoreValue): AuthSecurityEvent {
  const event = value as unknown as Omit<AuthSecurityEvent, "occurredAt"> & {
    occurredAt: string;
  };
  return { ...event, occurredAt: new Date(event.occurredAt) };
}

function reviveAuthorizationFlow(value: ZelavisSystemStoreValue): AuthAuthorizationFlow {
  const flow = value as unknown as Omit<
    AuthAuthorizationFlow,
    "createdAt" | "expiresAt"
  > & { createdAt: string; expiresAt: string };
  return {
    ...flow,
    createdAt: new Date(flow.createdAt),
    expiresAt: new Date(flow.expiresAt),
  };
}

export function createPlatformAuthRepositories(store: ZelavisSystemStore): AuthRepositories {
  const get = async <T extends Account | Credential | Session>(kind: string, id: string) => {
    const record = await store.get(NAMESPACE, `${kind}:${id}`);
    return record ? revive<T>(record.value) : null;
  };
  const list = async <T extends Account | Credential | Session>(kind: string) =>
    (await store.list(NAMESPACE))
      .filter((record) => record.key.startsWith(`${kind}:`))
      .map((record) => revive<T>(record.value));
  const set = async <T extends Account | Credential | Session>(kind: string, entity: T) => {
    await store.set(NAMESPACE, `${kind}:${entity.id}`, storeValue(entity));
    return entity;
  };

  const accounts: AccountRepository = {
    create: (account) => set("account", account),
    async delete(id) { return store.delete(NAMESPACE, `account:${id}`); },
    findById: (id) => get("account", id),
    async findByEmail(email) { return (await list<Account>("account")).find((item) => item.email === email) ?? null; },
    async findByUsername(username) { return (await list<Account>("account")).find((item) => item.username === username) ?? null; },
    list: () => list("account"),
    update: (account) => set("account", account),
  };
  const credentials: CredentialRepository = {
    create: (credential) => set("credential", credential),
    async delete(id) { return store.delete(NAMESPACE, `credential:${id}`); },
    findById: (id) => get("credential", id),
    async findByProviderIdentifier(provider, identifier) {
      return (await list<Credential>("credential")).find(
        (item) => item.provider === provider && item.identifier === identifier,
      ) ?? null;
    },
    async listByAccountId(accountId) {
      return (await list<Credential>("credential")).filter((item) => item.accountId === accountId);
    },
    update: (credential) => set("credential", credential),
  };
  const sessions: SessionRepository = {
    create: (session) => set("session", session),
    async delete(id) { return store.delete(NAMESPACE, `session:${id}`); },
    findById: (id) => get("session", id),
    async findByTokenHash(tokenHash) {
      return (await list<Session>("session")).find((item) => item.tokenHash === tokenHash) ?? null;
    },
    async listByAccountId(accountId) {
      return (await list<Session>("session")).filter((item) => item.accountId === accountId);
    },
    update: (session) => set("session", session),
  };
  const attempts: AuthAttemptRepository = {
    async findByKeyHash(keyHash) {
      const record = await store.get(NAMESPACE, `attempt:${keyHash}`);
      return record ? reviveAttempt(record.value) : null;
    },
    async mutate(keyHash, mutation) {
      const key = `attempt:${keyHash}`;
      for (let retry = 0; retry < 100; retry += 1) {
        const record = await store.get(NAMESPACE, key);
        const next = mutation(record ? reviveAttempt(record.value) : null);
        if (!record) {
          if (!next) return null;
          const created = await store.setIfAbsent(
            NAMESPACE,
            key,
            storeValue(next as unknown as Session),
          );
          if (created.created) return next;
          continue;
        }
        if (!next) {
          if (await store.compareAndDelete(NAMESPACE, key, record.updatedAt)) {
            return null;
          }
          continue;
        }
        const updated = await store.compareAndSet(
          NAMESPACE,
          key,
          record.updatedAt,
          storeValue(next as unknown as Session),
        );
        if (updated) return next;
      }
      throw new Error("Auth attempt update did not converge after 100 retries.");
    },
  };
  const authorizationFlows: AuthAuthorizationFlowRepository = {
    async findByStateHash(stateHash) {
      const record = await store.get(NAMESPACE, `authorization-flow:${stateHash}`);
      return record ? reviveAuthorizationFlow(record.value) : null;
    },
    async mutate(stateHash, mutation) {
      const key = `authorization-flow:${stateHash}`;
      for (let retry = 0; retry < 100; retry += 1) {
        const record = await store.get(NAMESPACE, key);
        const next = mutation(record ? reviveAuthorizationFlow(record.value) : null);
        if (!record) {
          if (!next) return null;
          const created = await store.setIfAbsent(NAMESPACE, key, storeValue(next));
          if (created.created) return next;
          continue;
        }
        if (!next) {
          if (await store.compareAndDelete(NAMESPACE, key, record.updatedAt)) return null;
          continue;
        }
        if (await store.compareAndSet(NAMESPACE, key, record.updatedAt, storeValue(next))) {
          return next;
        }
      }
      throw new Error("Authorization flow update did not converge after 100 retries.");
    },
  };
  const securityEvents: AuthSecurityEventRepository = {
    async append(event) {
      await store.set(NAMESPACE, `security-event:${event.occurredAt.toISOString()}:${event.id}`, storeValue(event as unknown as Session));
      return event;
    },
    async list() {
      return (await store.list(NAMESPACE))
        .filter((record) => record.key.startsWith("security-event:"))
        .map((record) => reviveSecurityEvent(record.value));
    },
  };
  return {
    accounts,
    credentials,
    sessions,
    attempts,
    authorizationFlows,
    securityEvents,
  };
}
