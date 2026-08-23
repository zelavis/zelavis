import type { Account, Credential, Session } from "../domain/entities.js";
export interface AccountRepository {
    create(account: Account): Promise<Account>;
    findById(id: string): Promise<Account | null>;
    findByEmail(email: string): Promise<Account | null>;
    findByUsername(username: string): Promise<Account | null>;
    list(): Promise<Account[]>;
    update(account: Account): Promise<Account>;
}
export interface SessionRepository {
    create(session: Session): Promise<Session>;
    findById(id: string): Promise<Session | null>;
    listByAccountId(accountId: string): Promise<Session[]>;
    update(session: Session): Promise<Session>;
}
export interface CredentialRepository {
    create(credential: Credential): Promise<Credential>;
    findById(id: string): Promise<Credential | null>;
    findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null>;
    listByAccountId(accountId: string): Promise<Credential[]>;
    update(credential: Credential): Promise<Credential>;
}
export interface AuthRepositories {
    accounts: AccountRepository;
    sessions: SessionRepository;
    credentials: CredentialRepository;
}
