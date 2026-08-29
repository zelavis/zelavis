import type { CredentialRepository } from "../contracts/repositories.js";
import type { Credential } from "../domain/entities.js";
import { AuthValidationError } from "../core/errors.js";

export interface CreateCredentialInput {
  id: string;
  accountId: string;
  provider: string;
  identifier: string;
  secretHash?: string;
  metadata?: Record<string, unknown>;
}

export class CredentialService {
  constructor(private readonly repository: CredentialRepository) {}

  async create(input: CreateCredentialInput): Promise<Credential> {
    if (!input.id) {
      throw new AuthValidationError("Credential creation requires an id.");
    }

    if (!input.accountId) {
      throw new AuthValidationError(
        "Credential creation requires an accountId.",
      );
    }

    if (!input.provider) {
      throw new AuthValidationError(
        "Credential creation requires a provider.",
      );
    }

    const identifier = input.provider === "email-password"
      ? input.identifier?.trim().toLowerCase()
      : input.identifier?.trim();
    if (!identifier) {
      throw new AuthValidationError(
        "Credential creation requires an identifier.",
      );
    }

    if (await this.repository.findByProviderIdentifier(input.provider, identifier)) {
      throw new AuthValidationError("That provider identifier is already registered.");
    }

    const now = new Date();
    return this.repository.create({
      ...input,
      identifier,
      createdAt: now,
      updatedAt: now,
    });
  }

  async findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null> {
    return this.repository.findByProviderIdentifier(provider, identifier);
  }

  async listByAccountId(accountId: string): Promise<Credential[]> {
    return this.repository.listByAccountId(accountId);
  }
}
