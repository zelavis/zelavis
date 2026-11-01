import { Effect } from "effect";
import { present, integration, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import type {
  AccountRepository,
  AuthAttemptRepository,
  IdentityAuthorizationFlowRepository,
  IdentityRepositories,
  AuthSecurityEventRepository,
  CredentialRepository,
  Mutation,
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
import {
  withUniqueAccounts,
  withUniqueCredentials,
  type ClaimBackend,
} from "./unique-claims.js";

/**
 * Claims held in a Map. Each method runs to completion with no `await` inside
 * it, so on one event loop a claim is atomic.
 */
class InMemoryClaims implements ClaimBackend {
  private readonly items = new Map<string, { owner: string; at: number }>();

  claim(key: string, owner: string) {
    const self = this;
    return present(Effect.gen(function* () {
    const existing = self.items.get(key);
    if (existing) return { claimed: false as const, owner: existing.owner, at: existing.at };
    self.items.set(key, { owner, at: Date.now() });
    return { claimed: true as const };
  }));
  }

  takeover(key: string, staleOwner: string, owner: string) {
    const self = this;
    return present(Effect.gen(function* () {
    if (self.items.get(key)?.owner !== staleOwner) return false;
    self.items.set(key, { owner, at: Date.now() });
    return true;
  }));
  }

  release(key: string, owner: string) {
    const self = this;
    return present(Effect.gen(function* () {
    if (self.items.get(key)?.owner === owner) self.items.delete(key);
  }));
  }
}

class InMemoryAccountRepository implements AccountRepository {
  private readonly items = new Map<string, Account>();

  create(account: Account): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account, IntegrationFailure> {
    self.items.set(account.id, account);
    return account;
  }));
  }

  delete(id: string): Promise<boolean> {
    return present(integration(() => this.items.delete(id)));
  }

  findById(id: string): Promise<Account | null> {
    return present(integration(() => this.items.get(id) ?? null));
  }

  findByEmail(email: string): Promise<Account | null> {
    return present(integration(() => Array.from(this.items.values()).find((account) => account.email === email) ?? null));
  }

  findByUsername(username: string): Promise<Account | null> {
    return present(integration(() => Array.from(this.items.values()).find((account) => account.username === username) ?? null));
  }

  list(): Promise<Account[]> {
    return present(integration(() => Array.from(this.items.values())));
  }

  update(account: Account): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account, IntegrationFailure> {
    self.items.set(account.id, account);
    return account;
  }));
  }

  mutate(id: string, mutation: Mutation<Account>): Promise<Account | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account | null, IntegrationFailure> {
    const next = mutation(self.items.get(id) ?? null);
    if (next) self.items.set(id, next);
    else self.items.delete(id);
    return next;
  }));
  }
}

class InMemorySessionRepository implements SessionRepository {
  private readonly items = new Map<string, Session>();

  create(session: Session): Promise<Session> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Session, IntegrationFailure> {
    self.items.set(session.id, session);
    return session;
  }));
  }

  delete(id: string): Promise<boolean> {
    return present(integration(() => this.items.delete(id)));
  }

  findById(id: string): Promise<Session | null> {
    return present(integration(() => this.items.get(id) ?? null));
  }

  findByTokenHash(tokenHash: string): Promise<Session | null> {
    return present(integration(() => Array.from(this.items.values()).find((session) => session.tokenHash === tokenHash) ?? null));
  }

  listByAccountId(accountId: string): Promise<Session[]> {
    return present(integration(() => Array.from(this.items.values()).filter((session) => session.accountId === accountId)));
  }

  update(session: Session): Promise<Session> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Session, IntegrationFailure> {
    self.items.set(session.id, session);
    return session;
  }));
  }

  mutate(id: string, mutation: Mutation<Session>): Promise<Session | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Session | null, IntegrationFailure> {
    const next = mutation(self.items.get(id) ?? null);
    if (next) self.items.set(id, next);
    else self.items.delete(id);
    return next;
  }));
  }
}

class InMemoryCredentialRepository implements CredentialRepository {
  private readonly items = new Map<string, Credential>();

  create(credential: Credential): Promise<Credential> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Credential, IntegrationFailure> {
    self.items.set(credential.id, credential);
    return credential;
  }));
  }

  delete(id: string): Promise<boolean> {
    return present(integration(() => this.items.delete(id)));
  }

  findById(id: string): Promise<Credential | null> {
    return present(integration(() => this.items.get(id) ?? null));
  }

  findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null> {
    return present(integration(() => Array.from(this.items.values()).find(
        (credential) => credential.provider === provider && credential.identifier === identifier,
      ) ?? null));
  }

  listByAccountId(accountId: string): Promise<Credential[]> {
    return present(integration(() => Array.from(this.items.values()).filter((credential) => credential.accountId === accountId)));
  }

  update(credential: Credential): Promise<Credential> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Credential, IntegrationFailure> {
    self.items.set(credential.id, credential);
    return credential;
  }));
  }
}

class InMemoryAuthAttemptRepository implements AuthAttemptRepository {
  private readonly items = new Map<string, AuthAttemptState>();

  findByKeyHash(keyHash: string): Promise<AuthAttemptState | null> {
    return present(integration(() => this.items.get(keyHash) ?? null));
  }

  mutate(
    keyHash: string,
    mutation: (current: AuthAttemptState | null) => AuthAttemptState | null,
  ): Promise<AuthAttemptState | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthAttemptState | null, IntegrationFailure> {
    const next = mutation(self.items.get(keyHash) ?? null);
    if (next) self.items.set(keyHash, next);
    else self.items.delete(keyHash);
    return next;
  }));
  }
}

class InMemoryAuthSecurityEventRepository
  implements AuthSecurityEventRepository {
  private readonly items: AuthSecurityEvent[] = [];

  append(event: AuthSecurityEvent): Promise<AuthSecurityEvent> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthSecurityEvent, IntegrationFailure> {
    self.items.push(event);
    return event;
  }));
  }

  list(): Promise<AuthSecurityEvent[]> {
    return present(integration(() => [...this.items]));
  }
}

class InMemoryAuthAuthorizationFlowRepository
  implements IdentityAuthorizationFlowRepository {
  private readonly items = new Map<string, IdentityAuthorizationFlow>();

  findByStateHash(stateHash: string): Promise<IdentityAuthorizationFlow | null> {
    return present(integration(() => this.items.get(stateHash) ?? null));
  }

  mutate(
    stateHash: string,
    mutation: (
      current: IdentityAuthorizationFlow | null,
    ) => IdentityAuthorizationFlow | null,
  ): Promise<IdentityAuthorizationFlow | null> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<IdentityAuthorizationFlow | null, IntegrationFailure> {
    const next = mutation(self.items.get(stateHash) ?? null);
    if (next) self.items.set(stateHash, next);
    else self.items.delete(stateHash);
    return next;
  }));
  }
}

export function createInMemoryAuthRepositories(
  overrides: Partial<IdentityRepositories> = {},
): IdentityRepositories {
  return {
    accounts: overrides.accounts ??
      withUniqueAccounts(new InMemoryAccountRepository(), new InMemoryClaims()),
    sessions: overrides.sessions ?? new InMemorySessionRepository(),
    credentials: overrides.credentials ??
      withUniqueCredentials(new InMemoryCredentialRepository(), new InMemoryClaims()),
    attempts: overrides.attempts ?? new InMemoryAuthAttemptRepository(),
    authorizationFlows:
      overrides.authorizationFlows ?? new InMemoryAuthAuthorizationFlowRepository(),
    securityEvents:
      overrides.securityEvents ?? new InMemoryAuthSecurityEventRepository(),
  };
}
