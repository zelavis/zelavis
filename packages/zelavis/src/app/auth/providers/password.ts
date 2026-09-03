import { AuthInvalidCredentialsError } from "../core/errors.js";
import { hashPassword, verifyPassword } from "../core/password.js";
import type {
  AuthenticationInput,
  AuthenticationResult,
  CredentialEnrollmentInput,
  CredentialProvider,
  CredentialProviderApi,
  PreparedCredential,
} from "../contracts/credential-provider.js";

/**
 * The password credential provider, built into Zelavis.
 *
 * This used to be two nearly identical plugins — one keyed on an email
 * address, one on a username — that the distribution copied into the
 * product-services folder on first boot. That seeding existed because a
 * Platform with no credential provider can never create its first owner, which
 * made the plugin mandatory in everything but name. Something an installation
 * cannot function without is not an extension.
 *
 * One provider handles both identifiers. Which kind an operator typed is
 * decided by the identifier itself rather than by installing a different
 * package, because an installation wanting both had to run two providers over
 * the same accounts.
 */
export const PASSWORD_PROVIDER = "password";

const RECOVERY_METADATA_KEY = "zelavis.auth.recovery";

/**
 * A verifier for a password nobody holds.
 *
 * An unknown identifier would otherwise skip key derivation and answer far
 * faster than a known one, which tells an unauthenticated caller whether an
 * account exists. Verifying against this keeps both paths doing the same work.
 */
const DECOY_PASSWORD_HASH =
  "pbkdf2-sha256$600000$yLraSn-7jde16kwYd-a7HQ$PjucgodjtQ-_xh7HLdhK_1NkRdh708YnHfRZ3wl52ag";

export interface PasswordProviderOptions {
  /** Lifetime of a session issued by a successful sign-in. */
  sessionTtlMs?: number;
  /** PBKDF2 iterations. Defaults to the auth core's own default. */
  iterations?: number;
  recovery?: {
    ttlMs?: number;
    deliver(input: {
      identifier: string;
      token: string;
      expiresAt: Date;
    }): Promise<void>;
  };
}

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function normalizeIdentifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Password sign-in requires an email address or username.");
  }
  return value.trim().toLowerCase();
}

/**
 * An identifier containing `@` is treated as an email address.
 *
 * Crude on purpose: the alternative is asking an operator to declare which
 * kind of identifier their installation uses, which is a setting that exists
 * only to answer a question the value itself already answers.
 */
function accountIdentity(identifier: string): { email?: string; username?: string } {
  return identifier.includes("@") ? { email: identifier } : { username: identifier };
}

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

export function createPasswordProvider(
  options: PasswordProviderOptions = {},
): CredentialProvider {
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const hashOptions = options.iterations === undefined ? {} : { iterations: options.iterations };

  const provider: CredentialProvider = {
    name: PASSWORD_PROVIDER,

    async prepareCredential(
      input: CredentialEnrollmentInput,
    ): Promise<PreparedCredential> {
      const identifier = normalizeIdentifier(input.identifier);
      if (typeof input.password !== "string") {
        throw new TypeError("Password enrollment requires a password.");
      }
      return {
        identifier,
        // hashPassword owns the length policy, so enrollment and recovery
        // agree on it without restating the rule in either place.
        secretHash: await hashPassword(input.password, hashOptions),
        accountIdentity: accountIdentity(identifier),
      };
    },

    async authenticate(
      input: AuthenticationInput,
      api: CredentialProviderApi,
    ): Promise<AuthenticationResult> {
      const identifier = normalizeIdentifier(input.identifier);
      const password = typeof input.password === "string" ? input.password : "";
      if (password.length > 1024) throw new AuthInvalidCredentialsError();

      const credential = await api.credentials.findByProviderIdentifier(
        PASSWORD_PROVIDER,
        identifier,
      );
      // Every failure below raises the same error and does the same work:
      // which of the identifier and the password was wrong is not the caller's
      // business, and neither is how long it took to find out.
      const valid = await verifyPassword(
        password,
        credential?.secretHash ?? DECOY_PASSWORD_HASH,
      );
      if (!credential?.secretHash || !valid) {
        throw new AuthInvalidCredentialsError();
      }

      const account = await api.accounts.findById(credential.accountId);
      if (!account) throw new AuthInvalidCredentialsError();

      return {
        account,
        credential,
        session: await api.sessions.create({
          accountId: account.id,
          expiresAt: new Date(Date.now() + sessionTtlMs),
          metadata: { provider: PASSWORD_PROVIDER },
        }),
      };
    },
  };

  if (options.recovery) {
    provider.beginRecovery = async (input, api) => {
      const identifier = normalizeIdentifier(input.identifier);
      const credential = await api.credentials.findByProviderIdentifier(
        PASSWORD_PROVIDER,
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
              // Stored as a hash: a leaked database must not hand someone a
              // working reset link.
              tokenHash: await recoveryTokenHash(token),
              expiresAt: expiresAt.toISOString(),
            },
          },
          updatedAt: new Date(),
        });
        await options.recovery!.deliver({ identifier, token, expiresAt });
      }
      // Accepted either way, so the response does not report whether an
      // account exists.
      return { accepted: true };
    };

    provider.completeRecovery = async (input, api) => {
      if (typeof input.token !== "string" || typeof input.password !== "string") {
        throw new AuthInvalidCredentialsError();
      }
      const identifier = normalizeIdentifier(input.identifier);
      const credential = await api.credentials.findByProviderIdentifier(
        PASSWORD_PROVIDER,
        identifier,
      );
      const recovery = credential?.metadata?.[RECOVERY_METADATA_KEY] as
        | { tokenHash?: unknown; expiresAt?: unknown }
        | undefined;
      if (
        !credential ||
        typeof recovery?.tokenHash !== "string" ||
        typeof recovery.expiresAt !== "string" ||
        new Date(recovery.expiresAt) <= new Date() ||
        (await recoveryTokenHash(input.token)) !== recovery.tokenHash
      ) {
        throw new AuthInvalidCredentialsError();
      }

      const { [RECOVERY_METADATA_KEY]: _used, ...metadata } = credential.metadata ?? {};
      await api.credentials.update({
        ...credential,
        secretHash: await hashPassword(input.password, hashOptions),
        metadata: Object.keys(metadata).length ? metadata : undefined,
        updatedAt: new Date(),
      });
      // Every existing session ends: a password reset is what someone does
      // when they believe the old one is known to somebody else.
      await api.sessions.revokeAll(credential.accountId);
    };
  }

  return provider;
}
