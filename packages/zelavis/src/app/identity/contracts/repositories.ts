import type {
  Account,
  AuthAttemptState,
  IdentityAuthorizationFlow,
  AuthSecurityEvent,
  Credential,
  Session,
} from "../domain/entities.js";

/**
 * Atomic read-modify-write on one record.
 *
 * The mutation may run more than once (it is retried when another writer got
 * there first), so it must be a pure function of `current`. Returning `null`
 * deletes; returning `current` unchanged is a no-op.
 */
export type Mutation<T> = (current: T | null) => T | null;

export interface AccountRepository {
  /**
   * Creates the account. **Email and username are unique**, and the check is
   * atomic with the write: a repository that loses the race throws
   * `IdentityConflictError`, never creates a second owner.
   */
  create(account: Account): Promise<Account>;
  /** Linearizable read-modify-write. May not change `email` or `username`. */
  mutate(id: string, mutation: Mutation<Account>): Promise<Account | null>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<Account | null>;
  findByEmail(email: string): Promise<Account | null>;
  findByUsername(username: string): Promise<Account | null>;
  list(): Promise<Account[]>;
  update(account: Account): Promise<Account>;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  /**
   * Linearizable read-modify-write. This is what makes a session token usable
   * exactly once by whoever wins a race to rotate it.
   */
  mutate(id: string, mutation: Mutation<Session>): Promise<Session | null>;
  delete(id: string): Promise<boolean>;
  findById(id: string): Promise<Session | null>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  listByAccountId(accountId: string): Promise<Session[]>;
  update(session: Session): Promise<Session>;
}

export interface CredentialRepository {
  /**
   * Creates the credential. `(provider, identifier)` is unique, atomically with
   * the write; losing the race throws `IdentityConflictError`.
   */
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
