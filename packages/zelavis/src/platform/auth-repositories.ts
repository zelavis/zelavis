import type {
  Account,
  AccountRepository,
  AuthRepositories,
  Credential,
  CredentialRepository,
  Session,
  SessionRepository,
} from "../app/auth/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "zelavis.platform.auth";

type StoredEntity = Record<string, ZelavisSystemStoreValue>;

function storeValue(entity: Account | Credential | Session): StoredEntity {
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
  return { accounts, credentials, sessions };
}
