import type { CredentialRepository } from "../contracts/repositories.js";
import type { Credential } from "../domain/entities.js";
export interface CreateCredentialInput {
    id: string;
    accountId: string;
    provider: string;
    identifier: string;
    secretHash?: string;
    metadata?: Record<string, unknown>;
}
export declare class CredentialService {
    private readonly repository;
    constructor(repository: CredentialRepository);
    create(input: CreateCredentialInput): Promise<Credential>;
    findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null>;
    listByAccountId(accountId: string): Promise<Credential[]>;
}
