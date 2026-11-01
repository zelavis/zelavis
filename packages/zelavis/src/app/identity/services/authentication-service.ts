import { Effect } from "effect";
import { present, integrationValue, unwrapFailure, type IntegrationFailure } from "../../../core/runtime/effect-boundary.js";
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
import type { IdentityAuthorizationFlowRepository } from "../contracts/repositories.js";
import type { Account, IdentityAuthorizationFlow } from "../domain/entities.js";
import type { AccountService } from "./account-service.js";
import type { CredentialService } from "./credential-service.js";
import type { SessionService } from "./session-service.js";
import {
  IdentityConflictError,
  IdentityNotFoundError,
  IdentityValidationError,
} from "../core/errors.js";

export interface AuthenticationServiceOptions {
  accounts: AccountService;
  credentials: CredentialService;
  sessions: SessionService;
  authorizationFlows: IdentityAuthorizationFlowRepository;
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

function sha256(value: string): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
  const bytes = new TextEncoder().encode(value);
  return (yield* integrationValue(base64Url(new Uint8Array((yield* integrationValue(crypto.subtle.digest("SHA-256", bytes)))))));
}));
  }

function generatedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export class AuthenticationService {
  private readonly providers = new Map<string, CredentialProvider>();

  constructor(private readonly options: AuthenticationServiceOptions) {}

  registerProvider(provider: CredentialProvider): CredentialProvider {
    if (!provider.name) {
      throw new IdentityValidationError(
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

  beginAuthorizationCode(
    providerName: string,
    input: BeginAuthorizationCodeInput = {},
  ): Promise<BeginAuthorizationCodeResult> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<BeginAuthorizationCodeResult, IntegrationFailure> {
    const provider = self.providers.get(providerName);
    if (!provider?.authorizationCode) {
      throw new IdentityNotFoundError(
        `Authentication provider ${providerName} does not support Authorization Code login.`,
      );
    }
    const mode = input.mode ?? "login";
    if (mode === "link" && !input.accountId) {
      throw new IdentityValidationError("Account linking requires an authenticated account.");
    }
    if (input.accountId && !((yield* integrationValue(self.options.accounts.findById(input.accountId))))) {
      throw new IdentityNotFoundError("The account selected for linking does not exist.");
    }

    const state = secureValue();
    const codeVerifier = secureValue(64);
    const nonce = secureValue();
    const stateHash = (yield* integrationValue(sha256(state)));
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const flow: IdentityAuthorizationFlow = {
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
    (yield* integrationValue(self.options.authorizationFlows.mutate(stateHash, (current) => {
      if (current) throw new IdentityValidationError("Authorization state collision.");
      return flow;
    })));
    const authorizationUrl = provider.authorizationCode.createAuthorizationUrl({
      state,
      nonce,
      codeChallenge: (yield* integrationValue(sha256(codeVerifier))),
      redirectUri: flow.redirectUri,
    });
    return { authorizationUrl: String(authorizationUrl), expiresAt };
  }));
  }

  completeAuthorizationCode(
    providerName: string,
    input: { state: string; code: string },
  ): Promise<AuthenticationResult> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthenticationResult, IntegrationFailure> {
    if (!input.state || !input.code) {
      throw new IdentityValidationError("Authorization callback requires state and code.");
    }
    const provider = self.providers.get(providerName);
    if (!provider?.authorizationCode) {
      throw new IdentityNotFoundError(
        `Authentication provider ${providerName} does not support Authorization Code login.`,
      );
    }
    const stateHash = yield* integrationValue(sha256(input.state));
    let consumed: IdentityAuthorizationFlow | null = null;
    yield* integrationValue(self.options.authorizationFlows.mutate(stateHash, (current) => {
      consumed = current;
      return null;
    }));
    const flow = consumed as IdentityAuthorizationFlow | null;
    if (!flow || flow.provider !== providerName || flow.expiresAt <= new Date()) {
      throw new IdentityValidationError("Authorization state is invalid or expired.");
    }

    const identity: AuthorizationCodeIdentity = yield* integrationValue(provider.authorizationCode.exchange({
      code: input.code,
      codeVerifier: flow.codeVerifier,
      nonce: flow.nonce,
      redirectUri: flow.redirectUri,
    }));
    if (!identity.identifier?.trim()) {
      throw new IdentityValidationError("Authorization provider returned no stable subject.");
    }
    const identifier = identity.identifier;
    const isConflict = (failure: IntegrationFailure) => unwrapFailure(failure) instanceof IdentityConflictError;

    const registered = yield* integrationValue(self.options.credentials.findByProviderIdentifier(
      providerName,
      identifier,
    ));
    let account;
    let credential = registered;
    if (flow.mode === "link") {
      const linked = yield* integrationValue(self.options.accounts.findById(flow.accountId!));
      if (!linked) throw new IdentityNotFoundError("The linked account no longer exists.");
      account = linked;
      if (credential && credential.accountId !== linked.id) {
        throw new IdentityValidationError("That external identity is linked to another account.");
      }
      if (!credential) {
        credential = yield* integrationValue(self.options.credentials.create({
          id: generatedId("credential"),
          accountId: linked.id,
          provider: providerName,
          identifier,
          metadata: identity.metadata,
        })).pipe(Effect.catchIf(isConflict, () => Effect.gen(function* () {
          // Another link for the same identity landed first: fine if it was to
          // this account, refused if it was to someone else's.
          const winner = yield* integrationValue(self.options.credentials.findByProviderIdentifier(
            providerName,
            identifier,
          ));
          if (!winner || winner.accountId !== linked.id) {
            throw new IdentityValidationError("That external identity is linked to another account.");
          }
          return winner;
        })));
      }
    } else if (credential) {
      const existing = yield* integrationValue(self.options.accounts.findById(credential.accountId));
      if (!existing) throw new IdentityNotFoundError("The linked account no longer exists.");
      account = existing;
    } else {
      // Two first logins for one external identity can arrive together. Both
      // see no credential; one wins the atomic create and the other must adopt
      // the winner's account rather than leave a second one behind.
      let created: Account | undefined;
      const adopted = yield* Effect.gen(function* () {
        created = yield* integrationValue(self.options.accounts.create({
          id: generatedId("account"),
          email: identity.email,
          username: identity.username ?? (!identity.email ? `oidc_${secureValue(9)}` : undefined),
          displayName: identity.displayName,
          verified: identity.verified ?? false,
          metadata: identity.metadata,
        }));
        const newCredential = yield* integrationValue(self.options.credentials.create({
          id: generatedId("credential"),
          accountId: created.id,
          provider: providerName,
          identifier,
          metadata: identity.metadata,
        }));
        return { account: created, credential: newCredential };
      }).pipe(Effect.catch((failure) => Effect.gen(function* () {
        if (created) yield* integrationValue(self.options.accounts.delete(created.id));
        if (!isConflict(failure)) return yield* Effect.fail(failure);
        const winner = yield* integrationValue(self.options.credentials.findByProviderIdentifier(
          providerName,
          identifier,
        ));
        const winnerAccount = winner
          ? yield* integrationValue(self.options.accounts.findById(winner.accountId))
          : null;
        if (!winner || !winnerAccount) return yield* Effect.fail(failure);
        return { account: winnerAccount, credential: winner };
      })));
      credential = adopted.credential;
      account = adopted.account;
    }

    const session = yield* integrationValue(self.options.sessions.create({
      accountId: account.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      metadata: { provider: providerName, authentication: "authorization-code" },
    }));
    return { account, credential, session };
    }));
  }

  beginRecovery(
    providerName: string,
    input: CredentialRecoveryStartInput,
  ): Promise<CredentialRecoveryStartResult> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<CredentialRecoveryStartResult, IntegrationFailure> {
    const provider = self.providers.get(providerName);
    if (!provider?.beginRecovery || !provider.completeRecovery) {
      throw new IdentityNotFoundError(
        `Authentication provider ${providerName} does not support recovery.`,
      );
    }
    return (yield* integrationValue(provider.beginRecovery(input, self.providerApi())));
  }));
  }

  completeRecovery(
    providerName: string,
    input: CredentialRecoveryCompleteInput,
  ): Promise<void> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    const provider = self.providers.get(providerName);
    if (!provider?.beginRecovery || !provider.completeRecovery) {
      throw new IdentityNotFoundError(
        `Authentication provider ${providerName} does not support recovery.`,
      );
    }
    (yield* integrationValue(provider.completeRecovery(input, self.providerApi())));
  }));
  }

  prepareCredential(
    providerName: string,
    input: CredentialEnrollmentInput,
  ): Promise<PreparedCredential> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<PreparedCredential, IntegrationFailure> {
    const provider = self.providers.get(providerName);
    if (!provider) {
      throw new IdentityNotFoundError(
        `Unknown authentication provider: ${providerName}`,
      );
    }
    if (!provider.prepareCredential) {
      throw new IdentityValidationError(
        `Authentication provider ${providerName} does not support credential enrollment.`,
      );
    }
    return (yield* integrationValue(provider.prepareCredential(input)));
  }));
  }

  authenticate(providerName: string, input: AuthenticationInput): Promise<AuthenticationResult> {
    const self = this;
    return present(Effect.gen(function* (): Effect.fn.Return<AuthenticationResult, IntegrationFailure> {
    const provider = self.providers.get(providerName);

    if (!provider) {
      throw new IdentityNotFoundError(
        `Unknown authentication provider: ${providerName}`,
      );
    }

    if (!provider.authenticate) {
      throw new IdentityValidationError(
        `Authentication provider ${providerName} requires its Authorization Code workflow.`,
      );
    }
    return (yield* integrationValue(provider.authenticate(input, self.providerApi())));
  }));
  }
}
