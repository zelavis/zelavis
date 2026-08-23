import { AuthValidationError } from "../core/errors.js";
export class CredentialService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async create(input) {
        if (!input.id) {
            throw new AuthValidationError("Credential creation requires an id.");
        }
        if (!input.accountId) {
            throw new AuthValidationError("Credential creation requires an accountId.");
        }
        if (!input.provider) {
            throw new AuthValidationError("Credential creation requires a provider.");
        }
        if (!input.identifier) {
            throw new AuthValidationError("Credential creation requires an identifier.");
        }
        const now = new Date();
        return this.repository.create({
            ...input,
            createdAt: now,
            updatedAt: now,
        });
    }
    async findByProviderIdentifier(provider, identifier) {
        return this.repository.findByProviderIdentifier(provider, identifier);
    }
    async listByAccountId(accountId) {
        return this.repository.listByAccountId(accountId);
    }
}
