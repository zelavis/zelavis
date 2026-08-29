import type { AccountRepository } from "../contracts/repositories.js";
import type { Account } from "../domain/entities.js";
import type { ZelavisPrincipalGrant } from "../../../core/index.js";
import { AuthValidationError } from "../core/errors.js";

export interface CreateAccountInput {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified?: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly ZelavisPrincipalGrant[];
  metadata?: Record<string, unknown>;
}

export class AccountService {
  constructor(private readonly repository: AccountRepository) {}

  async create(input: CreateAccountInput): Promise<Account> {
    if (!input.id) {
      throw new AuthValidationError("Account creation requires an id.");
    }

    const email = input.email?.trim().toLowerCase();
    const username = input.username?.trim();
    if (!email && !username) {
      throw new AuthValidationError(
        "Account creation requires at least an email or username.",
      );
    }

    if (email && await this.repository.findByEmail(email)) {
      throw new AuthValidationError("An account already uses that email.");
    }
    if (username && await this.repository.findByUsername(username)) {
      throw new AuthValidationError("An account already uses that username.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      email,
      username,
      verified: input.verified ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findById(id: string): Promise<Account | null> {
    return this.repository.findById(id);
  }

  async findByEmail(email: string): Promise<Account | null> {
    return this.repository.findByEmail(email.trim().toLowerCase());
  }

  async findByUsername(username: string): Promise<Account | null> {
    return this.repository.findByUsername(username.trim());
  }

  async list(): Promise<Account[]> {
    return this.repository.list();
  }
}
