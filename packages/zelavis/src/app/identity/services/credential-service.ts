import { Effect } from "effect";
import { present, integration, integrationValue, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
import type { CredentialRepository } from "../contracts/repositories.js";
import type { Credential } from "../domain/entities.js";
import { IdentityValidationError } from "../core/errors.js";

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

  create(input: CreateCredentialInput): Promise<Credential> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Credential, IntegrationFailure> {
    if (!input.id) {
      throw new IdentityValidationError("Credential creation requires an id.");
    }

    if (!input.accountId) {
      throw new IdentityValidationError(
        "Credential creation requires an accountId.",
      );
    }

    if (!input.provider) {
      throw new IdentityValidationError(
        "Credential creation requires a provider.",
      );
    }

    const identifier = input.provider === "email-password"
      ? input.identifier?.trim().toLowerCase()
      : input.identifier?.trim();
    if (!identifier) {
      throw new IdentityValidationError(
        "Credential creation requires an identifier.",
      );
    }

    // Uniqueness is the repository's atomic job, not a check made here first.
    const now = new Date();
    return (yield* integrationValue(self.repository.create({
      ...input,
      identifier,
      createdAt: now,
      updatedAt: now,
    })));
  }));
  }

  findByProviderIdentifier(provider: string, identifier: string): Promise<Credential | null> {
    return present(integration(() => this.repository.findByProviderIdentifier(provider, identifier)));
  }

  findById(id: string): Promise<Credential | null> {
    return present(integration(() => this.repository.findById(id)));
  }

  update(credential: Credential): Promise<Credential> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<Credential, IntegrationFailure> {
    if (!credential.id || !credential.accountId || !credential.provider || !credential.identifier) {
      throw new IdentityValidationError("Credential updates require a complete credential.");
    }
    return (yield* integrationValue(self.repository.update({
      ...credential,
      updatedAt: new Date(),
    })));
  }));
  }

  listByAccountId(accountId: string): Promise<Credential[]> {
    return present(integration(() => this.repository.listByAccountId(accountId)));
  }
}
