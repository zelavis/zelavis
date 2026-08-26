import type {
  AccountRepository,
  AuthRepositories,
  CredentialRepository,
  SessionRepository,
} from "../contracts/repositories.js";
import type { Account, Credential, Session } from "../domain/entities.js";

class InMemoryAccountRepository implements AccountRepository {
  private readonly items = new Map<string, Account>();

  async create(account: Account): Promise<Account> {
    this.items.set(account.id, account);
    return account;
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

  async findById(id: string): Promise<Session | null> {
    return this.items.get(id) ?? null;
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

export function createInMemoryAuthRepositories(
  overrides: Partial<AuthRepositories> = {},
): AuthRepositories {
  return {
    accounts: overrides.accounts ?? new InMemoryAccountRepository(),
    sessions: overrides.sessions ?? new InMemorySessionRepository(),
    credentials: overrides.credentials ?? new InMemoryCredentialRepository(),
  };
}
