import { AuthInvalidCredentialsError, type AuthenticationResult, type AuthApi, type AuthMethodPlugin, type CredentialProvider } from "zelavis/app/auth";
import { defineService } from "zelavis/service";
import { hashPassword, verifyPassword } from "zelavis/app/auth";

const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$600000$yLraSn-7jde16kwYd-a7HQ$PjucgodjtQ-_xh7HLdhK_1NkRdh708YnHfRZ3wl52ag";

export interface UsernamePasswordServiceOptions {
  createSession?: boolean;
  getSessionExpiry?: () => Date;
  verifyPasswordHash?(input: { password: string; passwordHash: string }): Promise<boolean>;
}

function invalidCredentials(): never {
  throw new AuthInvalidCredentialsError();
}

export function createUsernamePasswordProvider(
  options: UsernamePasswordServiceOptions,
): CredentialProvider {
  return {
    name: "username-password",
    async prepareCredential(input) {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Username/password enrollment requires a username identifier.");
      }
      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Username/password enrollment requires a password.");
      }
      return {
        identifier: input.identifier.trim(),
        secretHash: await hashPassword(input.password),
        accountIdentity: { username: input.identifier.trim() },
      };
    },
    async authenticate(input, api): Promise<AuthenticationResult> {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Username/password authentication requires an identifier.");
      }

      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Username/password authentication requires a password.");
      }
      if (input.password.length > 1024) invalidCredentials();

      const credential = await api.credentials.findByProviderIdentifier("username-password", input.identifier.trim());

      const valid = await (options.verifyPasswordHash ?? ((value) => verifyPassword(value.password, value.passwordHash)))({
        password: input.password,
        passwordHash: credential?.secretHash ?? DUMMY_PASSWORD_HASH,
      });

      if (!credential?.secretHash || !valid) {
        invalidCredentials();
      }

      const account = await api.accounts.findById(credential.accountId);

      if (!account) {
        invalidCredentials();
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

export function usernamePasswordService(options: UsernamePasswordServiceOptions = {}) {
  const method: AuthMethodPlugin = {
    name: "username-password",
    register(api) {
      api.authentication.registerProvider(createUsernamePasswordProvider(options));
    },
  };
  return defineService({
    name: "@zelavis/auth-username-password",
    kind: "provider",
    capabilities: ["provider:auth"],
    service: method,
  });
}
