import { AuthValidationError } from "../core/errors.js";
export class AccountService {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    async create(input) {
        if (!input.id) {
            throw new AuthValidationError("Account creation requires an id.");
        }
        if (!input.email && !input.username) {
            throw new AuthValidationError("Account creation requires at least an email or username.");
        }
        const now = new Date();
        return this.repository.create({
            ...input,
            verified: input.verified ?? false,
            createdAt: now,
            updatedAt: now,
        });
    }
    async findById(id) {
        return this.repository.findById(id);
    }
    async findByEmail(email) {
        return this.repository.findByEmail(email);
    }
    async findByUsername(username) {
        return this.repository.findByUsername(username);
    }
    async list() {
        return this.repository.list();
    }
}
