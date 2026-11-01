import { Effect } from "effect";
import { present, integration, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
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

  create(input: CreateAccountInput): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account, IntegrationFailure> {
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

    // No look-before-write: two callers can both find nothing. The repository
    // enforces uniqueness atomically and throws `IdentityConflictError`.
    const now = new Date();
    return (yield* integrationValue(self.repository.create({
      ...input,
      email,
      username,
      verified: input.verified ?? false,
      createdAt: now,
      updatedAt: now,
    })));
  }));
  }

  findById(id: string): Promise<Account | null> {
    return present(integration(() => this.repository.findById(id)));
  }

  delete(id: string): Promise<boolean> {
    return present(integration(() => this.repository.delete(id)));
  }

  findByEmail(email: string): Promise<Account | null> {
    return present(integration(() => this.repository.findByEmail(email.trim().toLowerCase())));
  }

  findByUsername(username: string): Promise<Account | null> {
    return present(integration(() => this.repository.findByUsername(username.trim())));
  }

  list(): Promise<Account[]> {
    return present(integration(() => this.repository.list()));
  }

  /**
   * Replaces an account's metadata.
   *
   * Whole-record rather than a merge, so the caller decides what survives: a
   * merge here would make removing a key impossible without a second
   * operation, and metadata is where authority-adjacent facts like the
   * Tenant live.
   */
  setMetadata(id: string, metadata: Record<string, unknown>): Promise<Account> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Account, IntegrationFailure> {
    const account = (yield* integrationValue(self.repository.findById(id)));
    if (!account) {
      throw new IdentityValidationError("No account with that id exists.");
    }
    return (yield* integrationValue(self.repository.update({ ...account, metadata, updatedAt: new Date() })));
  }));
  }
}
