import type { AuthenticationResult, CredentialProvider } from "@zelavis/auth";
import { defineAuthPlugin } from "@zelavis/auth";

export interface EmailPasswordPluginOptions {
  createSession?: boolean;
  getSessionExpiry?: () => Date;
  verifyPasswordHash(input: { password: string; passwordHash: string }): Promise<boolean>;
}

function invalidCredentials(): never {
  throw new Error("Invalid credentials.");
}

export function createEmailPasswordProvider(
  options: EmailPasswordPluginOptions,
): CredentialProvider {
  return {
    name: "email-password",
    async authenticate(input, api): Promise<AuthenticationResult> {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Email/password authentication requires an identifier.");
      }

      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Email/password authentication requires a password.");
      }

      const credential = await api.credentials.findByProviderIdentifier("email-password", input.identifier);

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
                provider: "email-password",
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

export function emailPasswordPlugin(options: EmailPasswordPluginOptions) {
  return defineAuthPlugin({
    name: "email-password",
    setup(api) {
      api.authentication.registerProvider(createEmailPasswordProvider(options));
    },
  });
}
