import type {
  AuthenticationInput,
  AuthenticationResult,
  CredentialEnrollmentInput,
  CredentialRecoveryCompleteInput,
  CredentialRecoveryStartInput,
  CredentialRecoveryStartResult,
  CredentialProvider,
  CredentialProviderApi,
  PreparedCredential,
  AuthorizationCodeIdentity,
} from "../contracts/credential-provider.js";
import type { AuthAuthorizationFlowRepository } from "../contracts/repositories.js";
import type { AuthAuthorizationFlow } from "../domain/entities.js";
import type { AccountService } from "./account-service.js";
import type { CredentialService } from "./credential-service.js";
import type { SessionService } from "./session-service.js";
import { AuthNotFoundError, AuthValidationError } from "../core/errors.js";

export interface AuthenticationServiceOptions {
  accounts: AccountService;
  credentials: CredentialService;
  sessions: SessionService;
  authorizationFlows: AuthAuthorizationFlowRepository;
}

export interface BeginAuthorizationCodeInput {
  mode?: "login" | "link";
  accountId?: string;
}

export interface BeginAuthorizationCodeResult {
  authorizationUrl: string;
  expiresAt: Date;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function secureValue(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function generatedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
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

  listRecoveryProviders(): string[] {
    return Array.from(this.providers.values())
      .filter(
        (provider) =>
          typeof provider.beginRecovery === "function" &&
          typeof provider.completeRecovery === "function",
      )
      .map((provider) => provider.name);
  }

  listAuthorizationCodeProviders(): string[] {
    return Array.from(this.providers.values())
      .filter((provider) => provider.authorizationCode !== undefined)
      .map((provider) => provider.name);
  }

  private providerApi(): CredentialProviderApi {
    return {
      accounts: {
        create: (account) => this.options.accounts.create(account),
        findById: (id) => this.options.accounts.findById(id),
        findByEmail: (email) => this.options.accounts.findByEmail(email),
        findByUsername: (username) => this.options.accounts.findByUsername(username),
      },
      credentials: {
        create: (credential) => this.options.credentials.create(credential),
        findByProviderIdentifier: (registeredProvider, identifier) =>
          this.options.credentials.findByProviderIdentifier(registeredProvider, identifier),
        update: (credential) => this.options.credentials.update(credential),
      },
      sessions: {
        create: (session) => this.options.sessions.create(session),
        revokeAll: (accountId) => this.options.sessions.revokeAll(accountId),
      },
    };
  }

  async beginAuthorizationCode(
    providerName: string,
    input: BeginAuthorizationCodeInput = {},
  ): Promise<BeginAuthorizationCodeResult> {
    const provider = this.providers.get(providerName);
    if (!provider?.authorizationCode) {
      throw new AuthNotFoundError(
        `Authentication provider ${providerName} does not support Authorization Code login.`,
      );
    }
    const mode = input.mode ?? "login";
    if (mode === "link" && !input.accountId) {
      throw new AuthValidationError("Account linking requires an authenticated account.");
    }
    if (input.accountId && !(await this.options.accounts.findById(input.accountId))) {
      throw new AuthNotFoundError("The account selected for linking does not exist.");
    }

    const state = secureValue();
    const codeVerifier = secureValue(64);
    const nonce = secureValue();
    const stateHash = await sha256(state);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const flow: AuthAuthorizationFlow = {
      stateHash,
      provider: providerName,
      mode,
      accountId: input.accountId,
      redirectUri: provider.authorizationCode.redirectUri,
      codeVerifier,
      nonce,
      createdAt: new Date(),
      expiresAt,
    };
    await this.options.authorizationFlows.mutate(stateHash, (current) => {
      if (current) throw new AuthValidationError("Authorization state collision.");
      return flow;
    });
    const authorizationUrl = provider.authorizationCode.createAuthorizationUrl({
      state,
      nonce,
      codeChallenge: await sha256(codeVerifier),
      redirectUri: flow.redirectUri,
    });
    return { authorizationUrl: String(authorizationUrl), expiresAt };
  }

  async completeAuthorizationCode(
    providerName: string,
    input: { state: string; code: string },
  ): Promise<AuthenticationResult> {
    if (!input.state || !input.code) {
      throw new AuthValidationError("Authorization callback requires state and code.");
    }
    const provider = this.providers.get(providerName);
    if (!provider?.authorizationCode) {
      throw new AuthNotFoundError(
        `Authentication provider ${providerName} does not support Authorization Code login.`,
      );
    }
    const stateHash = await sha256(input.state);
    let consumed: AuthAuthorizationFlow | null = null;
    await this.options.authorizationFlows.mutate(stateHash, (current) => {
      consumed = current;
      return null;
    });
    const flow = consumed as AuthAuthorizationFlow | null;
    if (!flow || flow.provider !== providerName || flow.expiresAt <= new Date()) {
      throw new AuthValidationError("Authorization state is invalid or expired.");
    }

    const identity: AuthorizationCodeIdentity = await provider.authorizationCode.exchange({
      code: input.code,
      codeVerifier: flow.codeVerifier,
      nonce: flow.nonce,
      redirectUri: flow.redirectUri,
    });
    if (!identity.identifier?.trim()) {
      throw new AuthValidationError("Authorization provider returned no stable subject.");
    }

    const registered = await this.options.credentials.findByProviderIdentifier(
      providerName,
      identity.identifier,
    );
    let account;
    let credential = registered;
    if (flow.mode === "link") {
      account = await this.options.accounts.findById(flow.accountId!);
      if (!account) throw new AuthNotFoundError("The linked account no longer exists.");
      if (credential && credential.accountId !== account.id) {
        throw new AuthValidationError("That external identity is linked to another account.");
      }
      credential ??= await this.options.credentials.create({
        id: generatedId("credential"),
        accountId: account.id,
        provider: providerName,
        identifier: identity.identifier,
        metadata: identity.metadata,
      });
    } else if (credential) {
      account = await this.options.accounts.findById(credential.accountId);
      if (!account) throw new AuthNotFoundError("The linked account no longer exists.");
    } else {
      account = await this.options.accounts.create({
        id: generatedId("account"),
        email: identity.email,
        username: identity.username ?? (!identity.email ? `oidc_${secureValue(9)}` : undefined),
        displayName: identity.displayName,
        verified: identity.verified ?? false,
        metadata: identity.metadata,
      });
      credential = await this.options.credentials.create({
        id: generatedId("credential"),
        accountId: account.id,
        provider: providerName,
        identifier: identity.identifier,
        metadata: identity.metadata,
      });
    }

    const session = await this.options.sessions.create({
      accountId: account.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      metadata: { provider: providerName, authentication: "authorization-code" },
    });
    return { account, credential, session };
  }

  async beginRecovery(
    providerName: string,
    input: CredentialRecoveryStartInput,
  ): Promise<CredentialRecoveryStartResult> {
    const provider = this.providers.get(providerName);
    if (!provider?.beginRecovery || !provider.completeRecovery) {
      throw new AuthNotFoundError(
        `Authentication provider ${providerName} does not support recovery.`,
      );
    }
    return provider.beginRecovery(input, this.providerApi());
  }

  async completeRecovery(
    providerName: string,
    input: CredentialRecoveryCompleteInput,
  ): Promise<void> {
    const provider = this.providers.get(providerName);
    if (!provider?.beginRecovery || !provider.completeRecovery) {
      throw new AuthNotFoundError(
        `Authentication provider ${providerName} does not support recovery.`,
      );
    }
    await provider.completeRecovery(input, this.providerApi());
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

    if (!provider.authenticate) {
      throw new AuthValidationError(
        `Authentication provider ${providerName} requires its Authorization Code workflow.`,
      );
    }
    return provider.authenticate(input, this.providerApi());
  }
}
