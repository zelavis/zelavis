import type { SessionRepository } from "../contracts/repositories.js";
import type { Session } from "../domain/entities.js";
export interface CreateSessionInput {
    accountId: string;
    expiresAt: Date;
    metadata?: Record<string, unknown>;
}
export declare class SessionService {
    private readonly repository;
    constructor(repository: SessionRepository);
    create(input: CreateSessionInput): Promise<Session>;
    findById(id: string): Promise<Session | null>;
    listByAccountId(accountId: string): Promise<Session[]>;
}
