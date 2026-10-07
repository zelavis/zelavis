import { Effect } from "effect";
import { present, integration, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { parseJson, isJsonObject } from "../core/json-validation.js";
import type {
  Account,
  AccountRepository,
  AuthAttemptState,
  AuthAttemptRepository,
  IdentityAuthorizationFlow,
  IdentityAuthorizationFlowRepository,
  IdentityRepositories,
  AuthSecurityEvent,
  AuthSecurityEventRepository,
  Credential,
  CredentialRepository,
  Mutation,
  Session,
  SessionRepository,
} from "../app/identity/index.js";
import {
  withUniqueAccounts,
  withUniqueCredentials,
  type ClaimBackend,
} from "../app/identity/storage/unique-claims.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "zelavis.platform.auth";

type StoredEntity = Record<string, ZelavisSystemStoreValue>;

function storeValue(entity: unknown): StoredEntity {
  return parseJson(JSON.stringify(entity), isJsonObject, "identity entity");
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

function reviveAuthorizationFlow(value: ZelavisSystemStoreValue): IdentityAuthorizationFlow {
  const flow = value as unknown as Omit<
    IdentityAuthorizationFlow,
    "createdAt" | "expiresAt"
  > & { createdAt: string; expiresAt: string };
  return {
    ...flow,
    createdAt: new Date(flow.createdAt),
    expiresAt: new Date(flow.expiresAt),
  };
}

/** Uniqueness claims as System Store records, created if-absent. */
function createStoreClaims(store: ZelavisSystemStore): ClaimBackend {
  const recordKey = (key: string) => `unique:${key}`;
  const read = (value: ZelavisSystemStoreValue) =>
    value as unknown as { owner: string; at: number };
  return {
    claim(key, owner) {
    const self = this;
    return present(Effect.gen(function* () {
      const created = (yield* integrationValue(store.setIfAbsent(NAMESPACE, recordKey(key), { owner, at: Date.now() })));
      if (created.created) return { claimed: true as const };
      const existing = (yield* integrationValue(store.get(NAMESPACE, recordKey(key))));
      if (!existing) return (yield* integrationValue(self.claim(key, owner)));
      const { owner: current, at } = read(existing.value);
      return { claimed: false as const, owner: current, at };
    }));
  },
    takeover(key, staleOwner, owner) {
    return present(Effect.gen(function* () {
      const existing = (yield* integrationValue(store.get(NAMESPACE, recordKey(key))));
      if (!existing || read(existing.value).owner !== staleOwner) return false;
      return (yield* integrationValue(Boolean(
        (yield* integrationValue(store.compareAndSet(NAMESPACE, recordKey(key), existing.updatedAt, {
          owner,
          at: Date.now(),
        }))),
      )));
    }));
  },
    release(key, owner) {
    return present(Effect.gen(function* () {
      const existing = (yield* integrationValue(store.get(NAMESPACE, recordKey(key))));
      if (existing && read(existing.value).owner === owner) {
        (yield* integrationValue(store.compareAndDelete(NAMESPACE, recordKey(key), existing.updatedAt)));
      }
    }));
  },
  };
}

export function createPlatformAuthRepositories(store: ZelavisSystemStore): IdentityRepositories {
  const mutateEntity = <T extends Account | Session>(
    kind: string,
    id: string,
    mutation: Mutation<T>,
  ): Promise<T | null> => present(Effect.gen(function* (): Effect.fn.Return<T | null, IntegrationFailure> {
    const key = `${kind}:${id}`;
    for (let retry = 0; retry < 100; retry += 1) {
      const record = (yield* integrationValue(store.get(NAMESPACE, key)));
      const next = mutation(record ? revive<T>(record.value) : null);
      if (!record) {
        if (!next) return null;
        if (((yield* integrationValue(store.setIfAbsent(NAMESPACE, key, storeValue(next))))).created) return next;
        continue;
      }
      if (!next) {
        if ((yield* integrationValue(store.compareAndDelete(NAMESPACE, key, record.updatedAt)))) return null;
        continue;
      }
      if ((yield* integrationValue(store.compareAndSet(NAMESPACE, key, record.updatedAt, storeValue(next))))) {
        return next;
      }
    }
    throw new Error(`${kind} update did not converge after 100 retries.`);
  }));

  const get = <T extends Account | Credential | Session>(kind: string, id: string) => present(Effect.gen(function* () {
    const record = (yield* integrationValue(store.get(NAMESPACE, `${kind}:${id}`)));
    return record ? revive<T>(record.value) : null;
  }));
  const list = <T extends Account | Credential | Session>(kind: string) =>
    present(Effect.gen(function* () {
    return (yield* integrationValue(((yield* integrationValue(store.list(NAMESPACE))))
      .filter((record) => record.key.startsWith(`${kind}:`))
      .map((record) => revive<T>(record.value))));
  }));
  const set = <T extends Account | Credential | Session>(kind: string, entity: T) => present(Effect.gen(function* () {
    (yield* integrationValue(store.set(NAMESPACE, `${kind}:${entity.id}`, storeValue(entity))));
    return entity;
  }));

  const baseAccounts: AccountRepository = {
    create: (account) => set("account", account),
    mutate: (id, mutation) => mutateEntity<Account>("account", id, mutation),
    delete(id) {
    return present(integration(() => store.delete(NAMESPACE, `account:${id}`)));
  },
    findById: (id) => get("account", id),
    findByEmail(email) {
    return present(Effect.gen(function* () { return ((yield* integrationValue(list<Account>("account")))).find((item) => item.email === email) ?? null; }));
  },
    findByUsername(username) {
    return present(Effect.gen(function* () { return ((yield* integrationValue(list<Account>("account")))).find((item) => item.username === username) ?? null; }));
  },
    list: () => list("account"),
    update: (account) => set("account", account),
  };
  const baseCredentials: CredentialRepository = {
    create: (credential) => set("credential", credential),
    delete(id) {
    return present(integration(() => store.delete(NAMESPACE, `credential:${id}`)));
  },
    findById: (id) => get("credential", id),
    findByProviderIdentifier(provider, identifier) {
    return present(Effect.gen(function* () {
      return ((yield* integrationValue(list<Credential>("credential")))).find(
        (item) => item.provider === provider && item.identifier === identifier,
      ) ?? null;
    }));
  },
    listByAccountId(accountId) {
    return present(Effect.gen(function* () {
      return (yield* integrationValue(((yield* integrationValue(list<Credential>("credential")))).filter((item) => item.accountId === accountId)));
    }));
  },
    update: (credential) => set("credential", credential),
  };
  const sessions: SessionRepository = {
    create: (session) => set("session", session),
    mutate: (id, mutation) => mutateEntity<Session>("session", id, mutation),
    delete(id) {
    return present(integration(() => store.delete(NAMESPACE, `session:${id}`)));
  },
    findById: (id) => get("session", id),
    findByTokenHash(tokenHash) {
    return present(Effect.gen(function* () {
      return ((yield* integrationValue(list<Session>("session")))).find((item) => item.tokenHash === tokenHash) ?? null;
    }));
  },
    listByAccountId(accountId) {
    return present(Effect.gen(function* () {
      return (yield* integrationValue(((yield* integrationValue(list<Session>("session")))).filter((item) => item.accountId === accountId)));
    }));
  },
    update: (session) => set("session", session),
  };
  const claims = createStoreClaims(store);
  const accounts = withUniqueAccounts(baseAccounts, claims);
  const credentials = withUniqueCredentials(baseCredentials, claims);
  const attempts: AuthAttemptRepository = {
    findByKeyHash(keyHash) {
    return present(Effect.gen(function* () {
      const record = (yield* integrationValue(store.get(NAMESPACE, `attempt:${keyHash}`)));
      return record ? reviveAttempt(record.value) : null;
    }));
  },
    mutate(keyHash, mutation) {
    return present(Effect.gen(function* () {
      const key = `attempt:${keyHash}`;
      for (let retry = 0; retry < 100; retry += 1) {
        const record = (yield* integrationValue(store.get(NAMESPACE, key)));
        const next = mutation(record ? reviveAttempt(record.value) : null);
        if (!record) {
          if (!next) return null;
          const created = (yield* integrationValue(store.setIfAbsent(
            NAMESPACE,
            key,
            storeValue(next as unknown as Session),
          )));
          if (created.created) return next;
          continue;
        }
        if (!next) {
          if ((yield* integrationValue(store.compareAndDelete(NAMESPACE, key, record.updatedAt)))) {
            return null;
          }
          continue;
        }
        const updated = (yield* integrationValue(store.compareAndSet(
          NAMESPACE,
          key,
          record.updatedAt,
          storeValue(next as unknown as Session),
        )));
        if (updated) return next;
      }
      throw new Error("Auth attempt update did not converge after 100 retries.");
    }));
  },
  };
  const authorizationFlows: IdentityAuthorizationFlowRepository = {
    findByStateHash(stateHash) {
    return present(Effect.gen(function* () {
      const record = (yield* integrationValue(store.get(NAMESPACE, `authorization-flow:${stateHash}`)));
      return record ? reviveAuthorizationFlow(record.value) : null;
    }));
  },
    mutate(stateHash, mutation) {
    return present(Effect.gen(function* () {
      const key = `authorization-flow:${stateHash}`;
      for (let retry = 0; retry < 100; retry += 1) {
        const record = (yield* integrationValue(store.get(NAMESPACE, key)));
        const next = mutation(record ? reviveAuthorizationFlow(record.value) : null);
        if (!record) {
          if (!next) return null;
          const created = (yield* integrationValue(store.setIfAbsent(NAMESPACE, key, storeValue(next))));
          if (created.created) return next;
          continue;
        }
        if (!next) {
          if ((yield* integrationValue(store.compareAndDelete(NAMESPACE, key, record.updatedAt)))) return null;
          continue;
        }
        if ((yield* integrationValue(store.compareAndSet(NAMESPACE, key, record.updatedAt, storeValue(next))))) {
          return next;
        }
      }
      throw new Error("Authorization flow update did not converge after 100 retries.");
    }));
  },
  };
  const securityEvents: AuthSecurityEventRepository = {
    append(event) {
    return present(Effect.gen(function* () {
      (yield* integrationValue(store.set(NAMESPACE, `security-event:${event.occurredAt.toISOString()}:${event.id}`, storeValue(event as unknown as Session))));
      return event;
    }));
  },
    list() {
    return present(Effect.gen(function* () {
      return (yield* integrationValue(((yield* integrationValue(store.list(NAMESPACE))))
        .filter((record) => record.key.startsWith("security-event:"))
        .map((record) => reviveSecurityEvent(record.value))));
    }));
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
