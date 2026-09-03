import { AuthInvalidCredentialsError, type AuthenticationResult, type AuthMethodPlugin, type CredentialProvider } from "zelavis/app/auth";
import { hashPassword, verifyPassword } from "zelavis/app/auth";

const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$600000$yLraSn-7jde16kwYd-a7HQ$PjucgodjtQ-_xh7HLdhK_1NkRdh708YnHfRZ3wl52ag";

export interface EmailPasswordServiceOptions {
  createSession?: boolean;
  getSessionExpiry?: () => Date;
  verifyPasswordHash?(input: { password: string; passwordHash: string }): Promise<boolean>;
  recovery?: {
    ttlMs?: number;
    deliver(input: {
      identifier: string;
      token: string;
      expiresAt: Date;
    }): Promise<void>;
  };
}

const RECOVERY_METADATA_KEY = "zelavis.auth.recovery";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function recoveryTokenHash(token: string): Promise<string> {
  const input = new TextEncoder().encode(token);
  const bytes = new Uint8Array(input.byteLength);
  bytes.set(input);
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer)));
}

function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function invalidCredentials(): never {
  throw new AuthInvalidCredentialsError();
}

export function createEmailPasswordProvider(
  options: EmailPasswordServiceOptions,
): CredentialProvider {
  const provider: CredentialProvider = {
    name: "email-password",
    async prepareCredential(input) {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Email/password enrollment requires an email identifier.");
      }
      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Email/password enrollment requires a password.");
      }
      return {
        identifier: input.identifier.trim().toLowerCase(),
        secretHash: await hashPassword(input.password),
        accountIdentity: { email: input.identifier.trim().toLowerCase() },
      };
    },
    async authenticate(input, api): Promise<AuthenticationResult> {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Email/password authentication requires an identifier.");
      }

      if (!input.password || typeof input.password !== "string") {
        throw new TypeError("Email/password authentication requires a password.");
      }
      if (input.password.length > 1024) invalidCredentials();

      const credential = await api.credentials.findByProviderIdentifier("email-password", input.identifier.trim().toLowerCase());

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
  if (options.recovery) {
    provider.beginRecovery = async (input, api) => {
      if (!input.identifier || typeof input.identifier !== "string") {
        throw new TypeError("Email/password recovery requires an email identifier.");
      }
      const identifier = input.identifier.trim().toLowerCase();
      const credential = await api.credentials.findByProviderIdentifier(
        "email-password",
        identifier,
      );
      if (credential) {
        const token = secureToken();
        const expiresAt = new Date(Date.now() + (options.recovery?.ttlMs ?? 15 * 60_000));
        await api.credentials.update({
          ...credential,
          metadata: {
            ...(credential.metadata ?? {}),
            [RECOVERY_METADATA_KEY]: {
              tokenHash: await recoveryTokenHash(token),
              expiresAt: expiresAt.toISOString(),
            },
          },
          updatedAt: new Date(),
        });
        await options.recovery!.deliver({ identifier, token, expiresAt });
      }
      return { accepted: true };
    };
    provider.completeRecovery = async (input, api) => {
      if (
        !input.identifier ||
        typeof input.identifier !== "string" ||
        !input.token ||
        typeof input.token !== "string" ||
        !input.password ||
        typeof input.password !== "string"
      ) {
        invalidCredentials();
      }
      const credential = await api.credentials.findByProviderIdentifier(
        "email-password",
        input.identifier.trim().toLowerCase(),
      );
      const recovery = credential?.metadata?.[RECOVERY_METADATA_KEY] as
        | { tokenHash?: unknown; expiresAt?: unknown }
        | undefined;
      if (
        !credential ||
        typeof recovery?.tokenHash !== "string" ||
        typeof recovery.expiresAt !== "string" ||
        new Date(recovery.expiresAt) <= new Date() ||
        await recoveryTokenHash(input.token) !== recovery.tokenHash
      ) {
        invalidCredentials();
      }
      const { [RECOVERY_METADATA_KEY]: _recovery, ...metadata } = credential.metadata ?? {};
      await api.credentials.update({
        ...credential,
        secretHash: await hashPassword(input.password),
        metadata: Object.keys(metadata).length ? metadata : undefined,
        updatedAt: new Date(),
      });
      await api.sessions.revokeAll(credential.accountId);
    };
  }
  return provider;
}

export function emailPasswordService(options: EmailPasswordServiceOptions = {}) {
  const method: AuthMethodPlugin = {
    name: "email-password",
    register(api) {
      api.authentication.registerProvider(createEmailPasswordProvider(options));
    },
  };
  return Object.freeze({
    name: "@zelavis/auth-email-password",
    kind: "plugin",
    // Names the core auth service this extends rather than a bare
    // `provider:auth` domain, so Platform auth collects it and another service
    // wanting credentials does not.
    capabilities: Object.freeze(["zelavis/auth:credentials"]),
    service: method,
  });
}

/**
 * The installed service.
 *
 * An installed package is loaded, not called: the Platform imports it and uses
 * what it finds. Default-exporting the factory meant the loader received a
 * function, produced no service object, and registered a package that
 * extended nothing. `emailPasswordService(...)` stays exported for hosts that
 * need to configure recovery delivery.
 */
export default emailPasswordService();
