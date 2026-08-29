import type { Account, Credential, IssuedSession } from "../domain/entities.js";

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

export interface CredentialProviderApi {
  accounts: {
    findById(id: string): Promise<Account | null>;
    findByEmail(email: string): Promise<Account | null>;
    findByUsername(username: string): Promise<Account | null>;
  };
  credentials: {
    findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null>;
  };
  sessions: {
    create(input: { accountId: string; expiresAt: Date; metadata?: Record<string, unknown> }): Promise<IssuedSession>;
  };
}

export interface CredentialProvider {
  name: string;
  prepareCredential?(
    input: CredentialEnrollmentInput,
  ): Promise<PreparedCredential>;
  authenticate(input: AuthenticationInput, api: CredentialProviderApi): Promise<AuthenticationResult>;
}
