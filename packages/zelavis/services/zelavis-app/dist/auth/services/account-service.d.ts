import type { AccountRepository } from "../contracts/repositories.js";
import type { Account } from "../domain/entities.js";
export interface CreateAccountInput {
    id: string;
    email?: string;
    username?: string;
    displayName?: string;
    verified?: boolean;
    metadata?: Record<string, unknown>;
}
export declare class AccountService {
    private readonly repository;
    constructor(repository: AccountRepository);
    create(input: CreateAccountInput): Promise<Account>;
    findById(id: string): Promise<Account | null>;
    findByEmail(email: string): Promise<Account | null>;
    findByUsername(username: string): Promise<Account | null>;
    list(): Promise<Account[]>;
}
