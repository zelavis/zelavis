import { Effect } from "effect";
import { present, integration, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
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

  ensure(collection: string): Promise<void> {
    if (this.ensured.has(collection)) return Promise.resolve();
    const active = this.ensuring.get(collection);
    if (active) return active;
    const self = this;
    const operation = present(Effect.gen(function* () {
      if (!((yield* integrationValue(self.database.documents.collectionExists(collection))))) {
        (yield* integrationValue(self.database.documents.createCollection({
          name: collection,
          surface: "database",
          metadata: { owner: "zelavis/app/identity" },
        })));
      }
      self.ensured.add(collection);
    }).pipe(Effect.ensuring(Effect.sync(() => { self.ensuring.delete(collection); }))));
    this.ensuring.set(collection, operation);
    return operation;
  }

  set<T extends IdentityEntity>(collection: string, entity: T): Promise<T> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<T, IntegrationFailure> {
    (yield* integrationValue(self.ensure(collection)));
    const existing = (yield* integrationValue(self.database.documents.findById({ collection, id: entity.id })));
    if (existing) {
      (yield* integrationValue(self.database.documents.update({ collection, id: entity.id, data: serialize(entity), mode: "replace" })));
    } else {
      (yield* integrationValue(self.database.documents.insert({ collection, id: entity.id, data: serialize(entity) })));
    }
    return entity;
  }));
  }

  /** Insert only: an existing id is a conflict, decided by the store. */
  create<T extends IdentityEntity>(collection: string, entity: T): Promise<T> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<T, IntegrationFailure | IdentityConflictError> {
      yield* integrationValue(self.ensure(collection));
      yield* integration(() => self.database.documents.insert({ collection, id: entity.id, data: serialize(entity) })).pipe(
        Effect.catchIf(isDocumentConflict, () => Effect.fail(new IdentityConflictError("id", "An identity record with that id already exists."))),
      );
      return entity;
    }));
  }

  get<T extends IdentityEntity>(collection: string, id: string): Promise<T | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<T | null, IntegrationFailure> {
    (yield* integrationValue(self.ensure(collection)));
    const document = (yield* integrationValue(self.database.documents.findById({ collection, id })));
    return document ? deserialize<T>(document.data) : null;
  }));
  }

  list<T extends IdentityEntity>(collection: string): Promise<T[]> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<T[], IntegrationFailure> {
    (yield* integrationValue(self.ensure(collection)));
    return (yield* integrationValue(((yield* integrationValue(self.database.documents.findMany({ collection })))).map((document) => deserialize<T>(document.data))));
  }));
  }

  delete(collection: string, id: string): Promise<boolean> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<boolean, IntegrationFailure> {
    (yield* integrationValue(self.ensure(collection)));
    return (yield* integrationValue(self.database.documents.delete({ collection, id })));
  }));
  }

  mutate<T extends IdentityEntity>(
    collection: string,
    id: string,
    mutation: (current: T | null) => T | null,
  ): Promise<T | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<T | null, IntegrationFailure> {
      yield* integrationValue(self.ensure(collection));
      for (let retry = 0; retry < 100; retry += 1) {
        const document = yield* integration(() => self.database.documents.findById({ collection, id }));
        const current = document ? deserialize<T>(document.data) : null;
        const next = mutation(current);
        const outcome = yield* Effect.gen(function* (): Effect.fn.Return<{ readonly value: T | null }, IntegrationFailure> {
          if (!document) {
            if (!next) return { value: null };
            yield* integration(() => self.database.documents.insert({
              collection,
              id,
              data: serialize(next),
            }));
            return { value: next };
          }
          if (!next) {
            yield* integration(() => self.database.documents.delete({
              collection,
              id,
              expectedVersion: document.version,
            }));
            return { value: null };
          }
          yield* integration(() => self.database.documents.update({
            collection,
            id,
            data: serialize(next),
            mode: "replace",
            expectedVersion: document.version,
          }));
          return { value: next };
        }).pipe(
          // The store fails with schema-tagged errors rather than classes, and
          // a lost optimistic-concurrency race and a duplicate insert are the
          // same tag: both mean another writer got there first, so both retry.
          Effect.catchIf(isDocumentConflict, () => Effect.succeed(undefined)),
        );
        if (outcome) return outcome.value;
      }
      throw new Error("Auth attempt update did not converge after 100 retries.");
    }));
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
  const ensure = () => ensured ??= present(Effect.gen(function* () {
    if (!((yield* integrationValue(database.documents.collectionExists(collection))))) {
      (yield* integrationValue(database.documents.createCollection({
        name: collection,
        surface: "database",
        metadata: { owner: "zelavis/app/identity" },
      })));
    }
  }));
  const idOf = (key: string) => present(Effect.gen(function* () {
    const digest = (yield* integrationValue(globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))));
    return (yield* integrationValue(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")));
  }));
  const read = (data: JsonObject) => data as unknown as { owner: string; at: number };
  return {
    claim(key, owner) {
      const self = this;
      return present(Effect.gen(function* (): Effect.fn.Return<Awaited<ReturnType<ClaimBackend["claim"]>>, IntegrationFailure> {
        yield* integrationValue(ensure());
        const id = yield* integrationValue(idOf(key));
        return yield* integration(() => database.documents.insert({ collection, id, data: { owner, at: Date.now() } })).pipe(
          Effect.as({ claimed: true as const }),
          Effect.catchIf(isDocumentConflict, () => Effect.gen(function* () {
            const existing = yield* integration(() => database.documents.findById({ collection, id }));
            if (!existing) return yield* integrationValue(self.claim(key, owner));
            const { owner: current, at } = read(existing.data);
            return { claimed: false as const, owner: current, at };
          })),
        );
      }));
    },
    takeover(key, staleOwner, owner) {
      return present(Effect.gen(function* (): Effect.fn.Return<boolean, IntegrationFailure> {
        yield* integrationValue(ensure());
        const id = yield* integrationValue(idOf(key));
        const existing = yield* integration(() => database.documents.findById({ collection, id }));
        if (!existing || read(existing.data).owner !== staleOwner) return false;
        return yield* integration(() => database.documents.update({
          collection,
          id,
          data: { owner, at: Date.now() },
          mode: "replace",
          expectedVersion: existing.version,
        })).pipe(
          Effect.as(true),
          Effect.catchIf(isDocumentConflict, () => Effect.succeed(false)),
        );
      }));
    },
    release(key, owner) {
      return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
        yield* integrationValue(ensure());
        const id = yield* integrationValue(idOf(key));
        const existing = yield* integration(() => database.documents.findById({ collection, id }));
        if (!existing || read(existing.data).owner !== owner) return;
        yield* integration(() => database.documents.delete({ collection, id, expectedVersion: existing.version })).pipe(
          Effect.catchIf(isDocumentConflict, () => Effect.void),
        );
      }));
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
    findByEmail(email) {
    return present(Effect.gen(function* () { return ((yield* integrationValue(store.list<Account>("auth_accounts")))).find((item) => item.email === email) ?? null; }));
  },
    findByUsername(username) {
    return present(Effect.gen(function* () { return ((yield* integrationValue(store.list<Account>("auth_accounts")))).find((item) => item.username === username) ?? null; }));
  },
    list: () => store.list("auth_accounts"),
  };
  const baseCredentials: CredentialRepository = {
    create: (entity) => store.create("auth_credentials", entity),
    delete: (id) => store.delete("auth_credentials", id),
    update: (entity) => store.set("auth_credentials", entity),
    findById: (id) => store.get("auth_credentials", id),
    findByProviderIdentifier(provider, identifier) {
    return present(Effect.gen(function* () {
      return ((yield* integrationValue(store.list<Credential>("auth_credentials")))).find(
        (item) => item.provider === provider && item.identifier === identifier,
      ) ?? null;
    }));
  },
    listByAccountId(accountId) {
    return present(Effect.gen(function* () { return (yield* integrationValue(((yield* integrationValue(store.list<Credential>("auth_credentials")))).filter((item) => item.accountId === accountId))); }));
  },
  };
  const sessions: SessionRepository = {
    create: (entity) => store.create("auth_sessions", entity),
    mutate: (id, mutation) => store.mutate<Session>("auth_sessions", id, mutation),
    delete: (id) => store.delete("auth_sessions", id),
    update: (entity) => store.set("auth_sessions", entity),
    findById: (id) => store.get("auth_sessions", id),
    findByTokenHash(tokenHash) {
    return present(Effect.gen(function* () { return ((yield* integrationValue(store.list<Session>("auth_sessions")))).find((item) => item.tokenHash === tokenHash) ?? null; }));
  },
    listByAccountId(accountId) {
    return present(Effect.gen(function* () { return (yield* integrationValue(((yield* integrationValue(store.list<Session>("auth_sessions")))).filter((item) => item.accountId === accountId))); }));
  },
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
