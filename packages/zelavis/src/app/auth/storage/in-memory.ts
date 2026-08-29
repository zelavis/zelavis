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
  implements AuthAuthorizationFlowRepository {
  private readonly items = new Map<string, AuthAuthorizationFlow>();

  async findByStateHash(stateHash: string): Promise<AuthAuthorizationFlow | null> {
    return this.items.get(stateHash) ?? null;
  }

  async mutate(
    stateHash: string,
    mutation: (
      current: AuthAuthorizationFlow | null,
    ) => AuthAuthorizationFlow | null,
  ): Promise<AuthAuthorizationFlow | null> {
    const next = mutation(this.items.get(stateHash) ?? null);
    if (next) this.items.set(stateHash, next);
    else this.items.delete(stateHash);
    return next;
  }
}

export function createInMemoryAuthRepositories(
  overrides: Partial<AuthRepositories> = {},
): AuthRepositories {
  return {
    accounts: overrides.accounts ?? new InMemoryAccountRepository(),
    sessions: overrides.sessions ?? new InMemorySessionRepository(),
    credentials: overrides.credentials ?? new InMemoryCredentialRepository(),
    attempts: overrides.attempts ?? new InMemoryAuthAttemptRepository(),
    authorizationFlows:
      overrides.authorizationFlows ?? new InMemoryAuthAuthorizationFlowRepository(),
    securityEvents:
      overrides.securityEvents ?? new InMemoryAuthSecurityEventRepository(),
  };
}
