import type {
  AuthenticationInput,
  AuthenticationResult,
  CredentialEnrollmentInput,
  CredentialProvider,
  CredentialProviderApi,
  PreparedCredential,
} from "../contracts/credential-provider.js";
import type { AccountService } from "./account-service.js";
import type { CredentialService } from "./credential-service.js";
import type { SessionService } from "./session-service.js";
import { AuthNotFoundError, AuthValidationError } from "../core/errors.js";

export interface AuthenticationServiceOptions {
  accounts: AccountService;
  credentials: CredentialService;
  sessions: SessionService;
}

export class AuthenticationService {
  private readonly providers = new Map<string, CredentialProvider>();

  constructor(private readonly options: AuthenticationServiceOptions) {}

  registerProvider(provider: CredentialProvider): CredentialProvider {
    if (!provider.name) {
      throw new AuthValidationError(
        "Credential provider registration requires a name.",
      );
    }

    this.providers.set(provider.name, provider);
    return provider;
  }

  getProvider(name: string): CredentialProvider | null {
    return this.providers.get(name) ?? null;
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  listEnrollmentProviders(): string[] {
    return Array.from(this.providers.values())
      .filter((provider) => typeof provider.prepareCredential === "function")
      .map((provider) => provider.name);
  }

  async prepareCredential(
    providerName: string,
    input: CredentialEnrollmentInput,
  ): Promise<PreparedCredential> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AuthNotFoundError(
        `Unknown authentication provider: ${providerName}`,
      );
    }
    if (!provider.prepareCredential) {
      throw new AuthValidationError(
        `Authentication provider ${providerName} does not support credential enrollment.`,
      );
    }
    return provider.prepareCredential(input);
  }

  async authenticate(providerName: string, input: AuthenticationInput): Promise<AuthenticationResult> {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new AuthNotFoundError(
        `Unknown authentication provider: ${providerName}`,
      );
    }

    const api: CredentialProviderApi = {
      accounts: {
        findById: (id) => this.options.accounts.findById(id),
        findByEmail: (email) => this.options.accounts.findByEmail(email),
        findByUsername: (username) => this.options.accounts.findByUsername(username),
      },
      credentials: {
        findByProviderIdentifier: (registeredProvider, identifier) =>
          this.options.credentials.findByProviderIdentifier(registeredProvider, identifier),
      },
      sessions: {
        create: (session) => this.options.sessions.create(session),
      },
    };

    return provider.authenticate(input, api);
  }
}
