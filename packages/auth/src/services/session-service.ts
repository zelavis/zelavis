import type { SessionRepository } from "../contracts/repositories.js";
import type { Session } from "../domain/entities.js";
import { AuthValidationError } from "../core/errors.js";

function createRandomUuid(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replaceAll(
    /[xy]/g,
    (character) => {
      const random = Math.floor(Math.random() * 16);
      const value = character === "x" ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    },
  );
}

export interface CreateSessionInput {
  accountId: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async create(input: CreateSessionInput): Promise<Session> {
    if (!input.accountId) {
      throw new AuthValidationError("Session creation requires an accountId.");
    }

    const now = new Date();
    return this.repository.create({
      id: `session_${createRandomUuid()}`,
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
