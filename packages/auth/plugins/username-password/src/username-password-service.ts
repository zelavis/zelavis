import type { AuthenticationResult, AuthApi, CredentialProvider } from "@zelavis/auth";
import { defineService } from "zelavis/service";

export interface UsernamePasswordServiceOptions {
  createSession?: boolean;
  getSessionExpiry?: () => Date;
  verifyPasswordHash(input: { password: string; passwordHash: string }): Promise<boolean>;
}

function invalidCredentials(): never {
  throw new Error("Invalid credentials.");
}

export function createUsernamePasswordProvider(
  options: UsernamePasswordServiceOptions,
): CredentialProvider {
  return {
    name: "@zelavis/auth-username-password",
    async authenticate(input, api): Promise<AuthenticationResult> {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Username/password authentication requires an identifier.");
      }

      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Username/password authentication requires a password.");
      }

      const credential = await api.credentials.findByProviderIdentifier("username-password", input.identifier);

      if (!credential?.secretHash) {
        invalidCredentials();
      }

      const valid = await options.verifyPasswordHash({
        password: input.password,
        passwordHash: credential.secretHash,
      });

      if (!valid) {
        invalidCredentials();
      }

      const account = await api.accounts.findById(credential.accountId);

      if (!account) {
        throw new Error("Account not found for credential.");
      }

      const session =
        options.createSession === false
          ? undefined
          : await api.sessions.create({
              accountId: account.id,
              expiresAt: options.getSessionExpiry?.() ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
              metadata: {
                provider: "username-password",
              },
            });

      return {
        account,
        credential,
        session,
      };
    },
  };
}

export function usernamePasswordService(options: UsernamePasswordServiceOptions) {
  return defineService<AuthApi>({
    name: "@zelavis/auth-username-password",
    kind: "provider",
    capabilities: ["provider:auth"],
    extends: "@zelavis/auth",
    setup(api) {
      api.authentication.registerProvider(createUsernamePasswordProvider(options));
    },
  });
}
