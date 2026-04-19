import { randomUUID } from "node:crypto";
import type { SessionRepository } from "../contracts/repositories.js";
import type { Session } from "../domain/entities.js";

export interface CreateSessionInput {
  accountId: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async create(input: CreateSessionInput): Promise<Session> {
    if (!input.accountId) {
      throw new TypeError("Session creation requires an accountId.");
    }

    const now = new Date();
    return this.repository.create({
      id: `session_${randomUUID()}`,
      accountId: input.accountId,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  async findById(id: string): Promise<Session | null> {
    return this.repository.findById(id);
  }

  async listByAccountId(accountId: string): Promise<Session[]> {
    return this.repository.listByAccountId(accountId);
  }
}
