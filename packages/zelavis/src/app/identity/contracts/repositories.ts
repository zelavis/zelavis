import type {
  Account,
  AuthAttemptState,
  IdentityAuthorizationFlow,
  AuthSecurityEvent,
  Credential,
  Session,
} from "../domain/entities.js";

export interface AccountRepository {
  create(account: Account): Promise<Account>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  findByUsername(username: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  update(account: Account): Promise<Account>;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<Session | null>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  listByAccountId(accountId: string): Promise<Session[]>;
  update(session: Session): Promise<Session>;
}

export interface CredentialRepository {
  create(credential: Credential): Promise<Credential>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<Credential | null>;
  findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null>;
  listByAccountId(accountId: string): Promise<Credential[]>;
  update(credential: Credential): Promise<Credential>;
}

export interface AuthAttemptRepository {
  findByKeyHash(keyHash: string): Promise<AuthAttemptState | null>;
  /** Linearizable read-modify-write for shared-process and shared-store limits. */
  mutate(
    keyHash: string,
    mutation: (current: AuthAttemptState | null) => AuthAttemptState | null,
  ): Promise<AuthAttemptState | null>;
}

export interface AuthSecurityEventRepository {
  append(event: AuthSecurityEvent): Promise<AuthSecurityEvent>;
  list(): Promise<AuthSecurityEvent[]>;
}

export interface IdentityAuthorizationFlowRepository {
  findByStateHash(stateHash: string): Promise<IdentityAuthorizationFlow | null>;
  mutate(
    stateHash: string,
    mutation: (
      current: IdentityAuthorizationFlow | null,
    ) => IdentityAuthorizationFlow | null,
  ): Promise<IdentityAuthorizationFlow | null>;
}

export interface IdentityRepositories {
  accounts: AccountRepository;
  sessions: SessionRepository;
  credentials: CredentialRepository;
  attempts: AuthAttemptRepository;
  authorizationFlows: IdentityAuthorizationFlowRepository;
  securityEvents: AuthSecurityEventRepository;
}
