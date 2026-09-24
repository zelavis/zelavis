import type {
  Account,
  Credential,
  IssuedSession,
  Session,
} from "../domain/entities.js";

export interface AuthenticationInput {
  identifier: string;
  password?: string;
  [key: string]: unknown;
}

export interface AuthenticationResult {
  account: Account;
  credential: Credential;
  session?: IssuedSession;
}

export interface CredentialEnrollmentInput {
  identifier: string;
  password?: string;
  [key: string]: unknown;
}

export interface PreparedCredential {
  identifier: string;
  secretHash?: string;
  metadata?: Record<string, unknown>;
  accountIdentity?: {
    email?: string;
    username?: string;
  };
}

export interface CredentialRecoveryStartInput {
  identifier: string;
  [key: string]: unknown;
}

export interface CredentialRecoveryStartResult {
  /** Deliberately generic so account existence is not exposed. */
  accepted: true;
}

export interface CredentialRecoveryCompleteInput {
  identifier: string;
  token: string;
  [key: string]: unknown;
}

export interface CredentialProviderApi {
  accounts: {
    create(input: {
      id: string;
      email?: string;
      username?: string;
      displayName?: string;
      verified?: boolean;
      metadata?: Record<string, unknown>;
    }): Promise<Account>;
    findById(id: string): Promise<Account | null>;
    findByEmail(email: string): Promise<Account | null>;
    findByUsername(username: string): Promise<Account | null>;
  };
  credentials: {
    create(input: {
      id: string;
      accountId: string;
      provider: string;
      identifier: string;
      metadata?: Record<string, unknown>;
    }): Promise<Credential>;
    findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null>;
    update(credential: Credential): Promise<Credential>;
  };
  sessions: {
    create(input: { accountId: string; expiresAt: Date; metadata?: Record<string, unknown> }): Promise<IssuedSession>;
    revokeAll(accountId: string): Promise<Session[]>;
  };
}

export interface AuthorizationCodeStartInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface AuthorizationCodeExchangeInput {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface AuthorizationCodeIdentity {
  identifier: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AuthorizationCodeProvider {
  redirectUri: string;
  createAuthorizationUrl(input: AuthorizationCodeStartInput): string | URL;
  exchange(input: AuthorizationCodeExchangeInput): Promise<AuthorizationCodeIdentity>;
}

export interface CredentialProvider {
  name: string;
  prepareCredential?(
    input: CredentialEnrollmentInput,
  ): Promise<PreparedCredential>;
  authenticate?(input: AuthenticationInput, api: CredentialProviderApi): Promise<AuthenticationResult>;
  authorizationCode?: AuthorizationCodeProvider;
  beginRecovery?(
    input: CredentialRecoveryStartInput,
    api: CredentialProviderApi,
  ): Promise<CredentialRecoveryStartResult>;
  completeRecovery?(
    input: CredentialRecoveryCompleteInput,
    api: CredentialProviderApi,
  ): Promise<void>;
}
