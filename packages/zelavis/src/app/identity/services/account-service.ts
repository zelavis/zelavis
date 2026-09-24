import type { AccountRepository } from "../contracts/repositories.js";
import type { Account } from "../domain/entities.js";
import type { ZelavisPrincipalGrant } from "../../../core/index.js";
import { IdentityValidationError } from "../core/errors.js";

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
      throw new IdentityValidationError("Account creation requires an id.");
    }

    const email = input.email?.trim().toLowerCase();
    const username = input.username?.trim();
    if (!email && !username) {
      throw new IdentityValidationError(
        "Account creation requires at least an email or username.",
      );
    }

    if (email && await this.repository.findByEmail(email)) {
      throw new IdentityValidationError("An account already uses that email.");
    }
    if (username && await this.repository.findByUsername(username)) {
      throw new IdentityValidationError("An account already uses that username.");
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

  /**
   * Replaces an account's metadata.
   *
   * Whole-record rather than a merge, so the caller decides what survives: a
   * merge here would make removing a key impossible without a second
   * operation, and metadata is where authority-adjacent facts like the
   * Tenant live.
   */
  async setMetadata(id: string, metadata: Record<string, unknown>): Promise<Account> {
    const account = await this.repository.findById(id);
    if (!account) {
      throw new IdentityValidationError("No account with that id exists.");
    }
    return this.repository.update({ ...account, metadata, updatedAt: new Date() });
  }
}
