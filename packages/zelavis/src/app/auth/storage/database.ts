import type {
  DatabaseRuntimeApi,
  JsonObject,
  TenantRuntimeApi,
} from "../../../db/index.js";
import type {
  AccountRepository,
  AuthAttemptRepository,
  AuthAuthorizationFlowRepository,
  AuthRepositories,
  AuthSecurityEventRepository,
  CredentialRepository,
  SessionRepository,
} from "../contracts/repositories.js";
import type {
  Account,
  AuthAttemptState,
  AuthAuthorizationFlow,
  AuthSecurityEvent,
  Credential,
  Session,
} from "../domain/entities.js";

type AuthEntity =
  | Account
  | Credential
  | Session
  | AuthSecurityEvent
  | (AuthAuthorizationFlow & { id: string })
  | (AuthAttemptState & { id: string });

function serialize(entity: AuthEntity): JsonObject {
  const updatedAt = "updatedAt" in entity
    ? entity.updatedAt
    : "occurredAt" in entity
      ? entity.occurredAt
      : entity.createdAt;
  return {
    entity: JSON.stringify(entity),
    updatedAt: updatedAt.toISOString(),
  };
}

function deserialize<T extends AuthEntity>(data: JsonObject): T {
  if (typeof data.entity !== "string") throw new TypeError("Stored Auth entity is invalid.");
  const entity = JSON.parse(data.entity) as Record<string, unknown>;
  for (const field of ["createdAt", "updatedAt", "expiresAt", "blockedUntil", "occurredAt"]) {
    if (typeof entity[field] === "string") entity[field] = new Date(entity[field] as string);
  }
  if (Array.isArray(entity.failures)) {
    entity.failures = entity.failures.map((failure) => new Date(failure as string));
  }
  return entity as unknown as T;
}

function isDocumentConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { _tag?: unknown; cause?: unknown };
  if (candidate._tag === "DocumentConflict") return true;
  return isDocumentConflict(candidate.cause);
}

class AuthDocumentStore {
  private readonly ensured = new Set<string>();
  private readonly ensuring = new Map<string, Promise<void>>();
  constructor(private readonly database: TenantRuntimeApi) {}

  async ensure(collection: string) {
    if (this.ensured.has(collection)) return;
    const active = this.ensuring.get(collection);
    if (active) return active;
    const operation = (async () => {
      if (!(await this.database.documents.collectionExists(collection))) {
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

  async mutate<T extends AuthEntity>(
    collection: string,
    id: string,
    mutation: (current: T | null) => T | null,
  ): Promise<T | null> {
    await this.ensure(collection);
    for (let retry = 0; retry < 100; retry += 1) {
      const document = await this.database.documents.findById({ collection, id });
      const current = document ? deserialize<T>(document.data) : null;
      const next = mutation(current);
      try {
        if (!document) {
          if (!next) return null;
          await this.database.documents.insert({
            collection,
            id,
            data: serialize(next),
          });
          return next;
        }
        if (!next) {
          await this.database.documents.delete({
            collection,
            id,
            expectedVersion: document.version,
          });
          return null;
        }
        await this.database.documents.update({
          collection,
          id,
          data: serialize(next),
          mode: "replace",
          expectedVersion: document.version,
        });
        return next;
      } catch (error) {
        // The store fails with schema-tagged errors rather than classes, and
        // a lost optimistic-concurrency race and a duplicate insert are the
        // same tag: both mean another writer got there first, so both retry.
        if (isDocumentConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("Auth attempt update did not converge after 100 retries.");
  }
}

export function createDatabaseAuthRepositories(
  database: DatabaseRuntimeApi,
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
  const attempts: AuthAttemptRepository = {
    findByKeyHash: (keyHash) =>
      store.get<AuthAttemptState & { id: string }>("auth_attempts", keyHash),
    mutate: (keyHash, mutation) =>
      store.mutate<AuthAttemptState & { id: string }>(
        "auth_attempts",
        keyHash,
        (current) => {
          const next = mutation(current);
          return next ? { ...next, id: keyHash } : null;
        },
      ),
  };
  const authorizationFlows: AuthAuthorizationFlowRepository = {
    findByStateHash: (stateHash) =>
      store.get<AuthAuthorizationFlow & { id: string }>(
        "auth_authorization_flows",
        stateHash,
      ),
    mutate: (stateHash, mutation) =>
      store.mutate<AuthAuthorizationFlow & { id: string }>(
        "auth_authorization_flows",
        stateHash,
        (current) => {
          const next = mutation(current);
          return next ? { ...next, id: stateHash } : null;
        },
      ),
  };
  const securityEvents: AuthSecurityEventRepository = {
    append: (event) => store.set<AuthSecurityEvent>("auth_security_events", event),
    list: () => store.list<AuthSecurityEvent>("auth_security_events"),
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
