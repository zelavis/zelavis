import { IdentityConflictError } from "../core/errors.js";
import type {
  DatabaseRuntimeApi,
  JsonObject,
  TenantRuntimeApi,
} from "../../../db/index.js";
import type {
  AccountRepository,
  AuthAttemptRepository,
  IdentityAuthorizationFlowRepository,
  IdentityRepositories,
  AuthSecurityEventRepository,
  CredentialRepository,
  SessionRepository,
} from "../contracts/repositories.js";
import type {
  Account,
  AuthAttemptState,
  IdentityAuthorizationFlow,
  AuthSecurityEvent,
  Credential,
  Session,
} from "../domain/entities.js";

type IdentityEntity =
  | Account
  | Credential
  | Session
  | AuthSecurityEvent
  | (IdentityAuthorizationFlow & { id: string })
  | (AuthAttemptState & { id: string });

function serialize(entity: IdentityEntity): JsonObject {
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

function deserialize<T extends IdentityEntity>(data: JsonObject): T {
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

import {
  withUniqueAccounts,
  withUniqueCredentials,
  type ClaimBackend,
} from "./unique-claims.js";

function isDocumentConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { _tag?: unknown; cause?: unknown };
  if (candidate._tag === "DocumentConflict") return true;
  return isDocumentConflict(candidate.cause);
}

class IdentityDocumentStore {
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
          metadata: { owner: "zelavis/app/identity" },
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

  async set<T extends IdentityEntity>(collection: string, entity: T): Promise<T> {
    await this.ensure(collection);
    const existing = await this.database.documents.findById({ collection, id: entity.id });
    if (existing) {
      await this.database.documents.update({ collection, id: entity.id, data: serialize(entity), mode: "replace" });
    } else {
      await this.database.documents.insert({ collection, id: entity.id, data: serialize(entity) });
    }
    return entity;
  }

  /** Insert only: an existing id is a conflict, decided by the store. */
  async create<T extends IdentityEntity>(collection: string, entity: T): Promise<T> {
    await this.ensure(collection);
    try {
      await this.database.documents.insert({ collection, id: entity.id, data: serialize(entity) });
    } catch (error) {
      if (isDocumentConflict(error)) {
        throw new IdentityConflictError("id", "An identity record with that id already exists.");
      }
      throw error;
    }
    return entity;
  }

  async get<T extends IdentityEntity>(collection: string, id: string): Promise<T | null> {
    await this.ensure(collection);
    const document = await this.database.documents.findById({ collection, id });
    return document ? deserialize<T>(document.data) : null;
  }

  async list<T extends IdentityEntity>(collection: string): Promise<T[]> {
    await this.ensure(collection);
    return (await this.database.documents.findMany({ collection })).map((document) => deserialize<T>(document.data));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    await this.ensure(collection);
    return this.database.documents.delete({ collection, id });
  }

  async mutate<T extends IdentityEntity>(
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

/**
 * Uniqueness claims as documents whose id *is* the unique value's digest.
 * Inserting an id that exists is a conflict the store reports atomically, which
 * is the whole guarantee; nothing here reads first and then decides.
 */
function createDocumentClaims(database: TenantRuntimeApi): ClaimBackend {
  const collection = "auth_unique";
  let ensured: Promise<void> | undefined;
  const ensure = () => ensured ??= (async () => {
    if (!(await database.documents.collectionExists(collection))) {
      await database.documents.createCollection({
        name: collection,
        surface: "database",
        metadata: { owner: "zelavis/app/identity" },
      });
    }
  })();
  const idOf = async (key: string) => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const read = (data: JsonObject) => data as unknown as { owner: string; at: number };
  return {
    async claim(key, owner) {
      await ensure();
      const id = await idOf(key);
      try {
        await database.documents.insert({ collection, id, data: { owner, at: Date.now() } });
        return { claimed: true as const };
      } catch (error) {
        if (!isDocumentConflict(error)) throw error;
        const existing = await database.documents.findById({ collection, id });
        if (!existing) return this.claim(key, owner);
        const { owner: current, at } = read(existing.data);
        return { claimed: false as const, owner: current, at };
      }
    },
    async takeover(key, staleOwner, owner) {
      await ensure();
      const id = await idOf(key);
      const existing = await database.documents.findById({ collection, id });
      if (!existing || read(existing.data).owner !== staleOwner) return false;
      try {
        await database.documents.update({
          collection,
          id,
          data: { owner, at: Date.now() },
          mode: "replace",
          expectedVersion: existing.version,
        });
        return true;
      } catch (error) {
        if (isDocumentConflict(error)) return false;
        throw error;
      }
    },
    async release(key, owner) {
      await ensure();
      const id = await idOf(key);
      const existing = await database.documents.findById({ collection, id });
      if (!existing || read(existing.data).owner !== owner) return;
      try {
        await database.documents.delete({ collection, id, expectedVersion: existing.version });
      } catch (error) {
        if (!isDocumentConflict(error)) throw error;
      }
    },
  };
}

export function createDatabaseAuthRepositories(
  database: DatabaseRuntimeApi,
  options: { tenantId?: string } = {},
): IdentityRepositories {
  const tenant = database.forTenant(options.tenantId ?? "service:zelavis-auth");
  const store = new IdentityDocumentStore(tenant);
  const claims = createDocumentClaims(tenant);
  const baseAccounts: AccountRepository = {
    create: (entity) => store.create("auth_accounts", entity),
    mutate: (id, mutation) => store.mutate<Account>("auth_accounts", id, mutation),
    delete: (id) => store.delete("auth_accounts", id),
    update: (entity) => store.set("auth_accounts", entity),
    findById: (id) => store.get("auth_accounts", id),
    async findByEmail(email) { return (await store.list<Account>("auth_accounts")).find((item) => item.email === email) ?? null; },
    async findByUsername(username) { return (await store.list<Account>("auth_accounts")).find((item) => item.username === username) ?? null; },
    list: () => store.list("auth_accounts"),
  };
  const baseCredentials: CredentialRepository = {
    create: (entity) => store.create("auth_credentials", entity),
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
    create: (entity) => store.create("auth_sessions", entity),
    mutate: (id, mutation) => store.mutate<Session>("auth_sessions", id, mutation),
    delete: (id) => store.delete("auth_sessions", id),
    update: (entity) => store.set("auth_sessions", entity),
    findById: (id) => store.get("auth_sessions", id),
    async findByTokenHash(tokenHash) { return (await store.list<Session>("auth_sessions")).find((item) => item.tokenHash === tokenHash) ?? null; },
    async listByAccountId(accountId) { return (await store.list<Session>("auth_sessions")).filter((item) => item.accountId === accountId); },
  };
  const accounts = withUniqueAccounts(baseAccounts, claims);
  const credentials = withUniqueCredentials(baseCredentials, claims);
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
  const authorizationFlows: IdentityAuthorizationFlowRepository = {
    findByStateHash: (stateHash) =>
      store.get<IdentityAuthorizationFlow & { id: string }>(
        "auth_authorization_flows",
        stateHash,
      ),
    mutate: (stateHash, mutation) =>
      store.mutate<IdentityAuthorizationFlow & { id: string }>(
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
