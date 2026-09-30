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

  async claim(key: string, owner: string) {
    const existing = this.items.get(key);
    if (existing) return { claimed: false as const, owner: existing.owner, at: existing.at };
    this.items.set(key, { owner, at: Date.now() });
    return { claimed: true as const };
  }

  async takeover(key: string, staleOwner: string, owner: string) {
    if (this.items.get(key)?.owner !== staleOwner) return false;
    this.items.set(key, { owner, at: Date.now() });
    return true;
  }

  async release(key: string, owner: string) {
    if (this.items.get(key)?.owner === owner) this.items.delete(key);
  }
}

class InMemoryAccountRepository implements AccountRepository {
  private readonly items = new Map<string, Account>();

  async create(account: Account): Promise<Account> {
    this.items.set(account.id, account);
    return account;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async findById(id: string): Promise<Account | null> {
    return this.items.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<Account | null> {
    return Array.from(this.items.values()).find((account) => account.email === email) ?? null;
  }

  async findByUsername(username: string): Promise<Account | null> {
    return Array.from(this.items.values()).find((account) => account.username === username) ?? null;
  }

  async list(): Promise<Account[]> {
    return Array.from(this.items.values());
  }

  async update(account: Account): Promise<Account> {
    this.items.set(account.id, account);
    return account;
  }

  async mutate(id: string, mutation: Mutation<Account>): Promise<Account | null> {
    const next = mutation(this.items.get(id) ?? null);
    if (next) this.items.set(id, next);
    else this.items.delete(id);
    return next;
  }
}

class InMemorySessionRepository implements SessionRepository {
  private readonly items = new Map<string, Session>();

  async create(session: Session): Promise<Session> {
    this.items.set(session.id, session);
    return session;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async findById(id: string): Promise<Session | null> {
    return this.items.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    return Array.from(this.items.values()).find((session) => session.tokenHash === tokenHash) ?? null;
  }

  async listByAccountId(accountId: string): Promise<Session[]> {
    return Array.from(this.items.values()).filter((session) => session.accountId === accountId);
  }

  async update(session: Session): Promise<Session> {
    this.items.set(session.id, session);
    return session;
  }

  async mutate(id: string, mutation: Mutation<Session>): Promise<Session | null> {
    const next = mutation(this.items.get(id) ?? null);
    if (next) this.items.set(id, next);
    else this.items.delete(id);
    return next;
  }
}

class InMemoryCredentialRepository implements CredentialRepository {
  private readonly items = new Map<string, Credential>();

  async create(credential: Credential): Promise<Credential> {
    this.items.set(credential.id, credential);
    return credential;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async findById(id: string): Promise<Credential | null> {
    return this.items.get(id) ?? null;
  }

  async findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null> {
    return (
      Array.from(this.items.values()).find(
        (credential) => credential.provider === provider && credential.identifier === identifier,
      ) ?? null
    );
  }

  async listByAccountId(accountId: string): Promise<Credential[]> {
    return Array.from(this.items.values()).filter((credential) => credential.accountId === accountId);
  }

  async update(credential: Credential): Promise<Credential> {
    this.items.set(credential.id, credential);
    return credential;
  }
}

class InMemoryAuthAttemptRepository implements AuthAttemptRepository {
  private readonly items = new Map<string, AuthAttemptState>();

  async findByKeyHash(keyHash: string): Promise<AuthAttemptState | null> {
    return this.items.get(keyHash) ?? null;
  }

  async mutate(
    keyHash: string,
    mutation: (current: AuthAttemptState | null) => AuthAttemptState | null,
  ): Promise<AuthAttemptState | null> {
    const next = mutation(this.items.get(keyHash) ?? null);
    if (next) this.items.set(keyHash, next);
    else this.items.delete(keyHash);
    return next;
  }
}

class InMemoryAuthSecurityEventRepository
  implements AuthSecurityEventRepository {
  private readonly items: AuthSecurityEvent[] = [];

  async append(event: AuthSecurityEvent): Promise<AuthSecurityEvent> {
    this.items.push(event);
    return event;
  }

  async list(): Promise<AuthSecurityEvent[]> {
    return [...this.items];
  }
}

class InMemoryAuthAuthorizationFlowRepository
  implements IdentityAuthorizationFlowRepository {
  private readonly items = new Map<string, IdentityAuthorizationFlow>();

  async findByStateHash(stateHash: string): Promise<IdentityAuthorizationFlow | null> {
    return this.items.get(stateHash) ?? null;
  }

  async mutate(
    stateHash: string,
    mutation: (
      current: IdentityAuthorizationFlow | null,
    ) => IdentityAuthorizationFlow | null,
  ): Promise<IdentityAuthorizationFlow | null> {
    const next = mutation(this.items.get(stateHash) ?? null);
    if (next) this.items.set(stateHash, next);
    else this.items.delete(stateHash);
    return next;
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
