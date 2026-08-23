import type { AccountRepository } from "../contracts/repositories.js";
import type { Account } from "../domain/entities.js";
import { AuthValidationError } from "../core/errors.js";

export interface CreateAccountInput {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified?: boolean;
  metadata?: Record<string, unknown>;
}

export class AccountService {
  constructor(private readonly repository: AccountRepository) {}

  async create(input: CreateAccountInput): Promise<Account> {
    if (!input.id) {
      throw new AuthValidationError("Account creation requires an id.");
    }

    if (!input.email && !input.username) {
      throw new AuthValidationError(
        "Account creation requires at least an email or username.",
      );
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      verified: input.verified ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findById(id: string): Promise<Account | null> {
    return this.repository.findById(id);
  }

  async findByEmail(email: string): Promise<Account | null> {
    return this.repository.findByEmail(email);
  }

  async findByUsername(username: string): Promise<Account | null> {
    return this.repository.findByUsername(username);
  }

  async list(): Promise<Account[]> {
    return this.repository.list();
  }
}
