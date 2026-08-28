import type { Account, Credential, Session } from "../domain/entities.js";

export interface AuthenticationInput {
  identifier: string;
  password?: string;
  [key: string]: unknown;
}

export interface AuthenticationResult {
  account: Account;
  credential: Credential;
  session?: Session;
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
    create(input: { accountId: string; expiresAt: Date; metadata?: Record<string, unknown> }): Promise<Session>;
  };
}

export interface CredentialProvider {
  name: string;
  authenticate(input: AuthenticationInput, api: CredentialProviderApi): Promise<AuthenticationResult>;
}
