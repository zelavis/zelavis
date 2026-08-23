class InMemoryAccountRepository {
    items = new Map();
    async create(account) {
        this.items.set(account.id, account);
        return account;
    }
    async findById(id) {
        return this.items.get(id) ?? null;
    }
    async findByEmail(email) {
        return Array.from(this.items.values()).find((account) => account.email === email) ?? null;
    }
    async findByUsername(username) {
        return Array.from(this.items.values()).find((account) => account.username === username) ?? null;
    }
    async list() {
        return Array.from(this.items.values());
    }
    async update(account) {
        this.items.set(account.id, account);
        return account;
    }
}
class InMemorySessionRepository {
    items = new Map();
    async create(session) {
        this.items.set(session.id, session);
        return session;
    }
    async findById(id) {
        return this.items.get(id) ?? null;
    }
    async listByAccountId(accountId) {
        return Array.from(this.items.values()).filter((session) => session.accountId === accountId);
    }
    async update(session) {
        this.items.set(session.id, session);
        return session;
    }
}
class InMemoryCredentialRepository {
    items = new Map();
    async create(credential) {
        this.items.set(credential.id, credential);
        return credential;
    }
    async findById(id) {
        return this.items.get(id) ?? null;
    }
    async findByProviderIdentifier(provider, identifier) {
        return (Array.from(this.items.values()).find((credential) => credential.provider === provider && credential.identifier === identifier) ?? null);
    }
    async listByAccountId(accountId) {
        return Array.from(this.items.values()).filter((credential) => credential.accountId === accountId);
    }
    async update(credential) {
        this.items.set(credential.id, credential);
        return credential;
    }
}
export function createInMemoryAuthRepositories(overrides = {}) {
    return {
        accounts: overrides.accounts ?? new InMemoryAccountRepository(),
        sessions: overrides.sessions ?? new InMemorySessionRepository(),
        credentials: overrides.credentials ?? new InMemoryCredentialRepository(),
    };
}
