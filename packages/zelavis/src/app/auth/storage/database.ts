import type { DatabaseApi, DatabaseJsonObject, TenantDatabaseApi } from "../../db/index.js";
import type {
  AccountRepository,
  AuthRepositories,
  CredentialRepository,
  SessionRepository,
} from "../contracts/repositories.js";
import type { Account, Credential, Session } from "../domain/entities.js";

type AuthEntity = Account | Credential | Session;

function serialize(entity: AuthEntity): DatabaseJsonObject {
  return {
    entity: JSON.stringify(entity),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

function deserialize<T extends AuthEntity>(data: DatabaseJsonObject): T {
  if (typeof data.entity !== "string") throw new TypeError("Stored Auth entity is invalid.");
  const entity = JSON.parse(data.entity) as T & {
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
  };
  return {
    ...entity,
    createdAt: new Date(entity.createdAt),
    updatedAt: new Date(entity.updatedAt),
    ...(typeof entity.expiresAt === "string" ? { expiresAt: new Date(entity.expiresAt) } : {}),
  } as T;
}

class AuthDocumentStore {
  private readonly ensured = new Set<string>();
  private readonly ensuring = new Map<string, Promise<void>>();
  constructor(private readonly database: TenantDatabaseApi) {}

  async ensure(collection: string) {
    if (this.ensured.has(collection)) return;
    const active = this.ensuring.get(collection);
    if (active) return active;
    const operation = (async () => {
      if (!(await this.database.documents.collectionExists({ name: collection }))) {
        await this.database.documents.createCollection({
          name: collection,
          surface: "database",
          metadata: { owner: "zelavis/app/auth" },
        });
      }
      this.ensured.add(collection);
    })();
    this.ensuring.set(collection, operation);
    try {
      await operation;
    } finally {
      this.ensuring.delete(collection);
    }
  }

  async set<T extends AuthEntity>(collection: string, entity: T): Promise<T> {
    await this.ensure(collection);
    const existing = await this.database.documents.findById({ collection, id: entity.id });
    if (existing) {
      await this.database.documents.update({ collection, id: entity.id, data: serialize(entity), mode: "replace" });
    } else {
      await this.database.documents.insert({ collection, id: entity.id, data: serialize(entity) });
    }
    return entity;
  }

  async get<T extends AuthEntity>(collection: string, id: string): Promise<T | null> {
    await this.ensure(collection);
    const document = await this.database.documents.findById({ collection, id });
    return document ? deserialize<T>(document.data) : null;
  }

  async list<T extends AuthEntity>(collection: string): Promise<T[]> {
    await this.ensure(collection);
    return (await this.database.documents.findMany({ collection })).map((document) => deserialize<T>(document.data));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    await this.ensure(collection);
    return this.database.documents.delete({ collection, id });
  }
}

export function createDatabaseAuthRepositories(
  database: DatabaseApi,
  options: { tenantId?: string } = {},
): AuthRepositories {
  const store = new AuthDocumentStore(database.forTenant(options.tenantId ?? "service:zelavis-auth"));
  const accounts: AccountRepository = {
    create: (entity) => store.set("auth_accounts", entity),
    delete: (id) => store.delete("auth_accounts", id),
    update: (entity) => store.set("auth_accounts", entity),
    findById: (id) => store.get("auth_accounts", id),
    async findByEmail(email) { return (await store.list<Account>("auth_accounts")).find((item) => item.email === email) ?? null; },
    async findByUsername(username) { return (await store.list<Account>("auth_accounts")).find((item) => item.username === username) ?? null; },
    list: () => store.list("auth_accounts"),
  };
  const credentials: CredentialRepository = {
    create: (entity) => store.set("auth_credentials", entity),
    delete: (id) => store.delete("auth_credentials", id),
    update: (entity) => store.set("auth_credentials", entity),
    findById: (id) => store.get("auth_credentials", id),
    async findByProviderIdentifier(provider, identifier) {
      return (await store.list<Credential>("auth_credentials")).find(
        (item) => item.provider === provider && item.identifier === identifier,
      ) ?? null;
    },
    async listByAccountId(accountId) { return (await store.list<Credential>("auth_credentials")).filter((item) => item.accountId === accountId); },
  };
  const sessions: SessionRepository = {
    create: (entity) => store.set("auth_sessions", entity),
    delete: (id) => store.delete("auth_sessions", id),
    update: (entity) => store.set("auth_sessions", entity),
    findById: (id) => store.get("auth_sessions", id),
    async findByTokenHash(tokenHash) { return (await store.list<Session>("auth_sessions")).find((item) => item.tokenHash === tokenHash) ?? null; },
    async listByAccountId(accountId) { return (await store.list<Session>("auth_sessions")).filter((item) => item.accountId === accountId); },
  };
  return { accounts, credentials, sessions };
}
