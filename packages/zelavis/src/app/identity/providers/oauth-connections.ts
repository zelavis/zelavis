import type { ZelavisSystemStoreValue } from "../../../system-store.js";
import type { ZelavisServiceStore } from "../../../platform/service-store.js";

/**
 * An operator's credentials for one identity provider.
 *
 * Stored rather than composed: the client id and secret are issued per
 * installation by the provider, so they cannot ship in a package and there is
 * no longer a constructor to pass them to.
 */
export interface OAuthConnection {
  provider: string;
  /**
   * The OIDC issuer this provider was discovered from, when it was not
   * supplied by a plugin. Kept so the endpoints can be re-read rather than
   * trusted from storage forever.
   */
  issuer?: string;
  /** Endpoints read from the issuer, cached so a restart needs no network. */
  discovered?: unknown;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
  enabled: boolean;
  updatedAt: string;
}

/** A connection as the API returns it. Never carries the secret. */
export type PublicOAuthConnection = Omit<
  OAuthConnection,
  "clientSecret" | "discovered"
> & {
  /** Whether a secret is stored, which is all a caller needs to know. */
  hasClientSecret: boolean;
};

export function publicConnection(
  connection: OAuthConnection,
): PublicOAuthConnection {
  // Built by naming the fields to keep rather than deleting the secret from a
  // copy: a future field added to the stored shape then has to be listed here
  // before it can leak.
  return {
    provider: connection.provider,
    ...(connection.issuer ? { issuer: connection.issuer } : {}),
    clientId: connection.clientId,
    redirectUri: connection.redirectUri,
    ...(connection.scopes ? { scopes: connection.scopes } : {}),
    enabled: connection.enabled,
    updatedAt: connection.updatedAt,
    hasClientSecret: Boolean(connection.clientSecret),
  };
}

const KEY_PREFIX = "connection:";

function connectionKey(provider: string): string {
  return `${KEY_PREFIX}${provider}`;
}

function isConnection(value: unknown): value is OAuthConnection {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.provider === "string" &&
    typeof record.clientId === "string" &&
    typeof record.redirectUri === "string" &&
    typeof record.enabled === "boolean"
  );
}

export interface OAuthConnectionStore {
  read(provider: string): Promise<OAuthConnection | undefined>;
  list(): Promise<readonly OAuthConnection[]>;
  write(connection: OAuthConnection): Promise<void>;
  remove(provider: string): Promise<boolean>;
}

export function createConnectionStore(
  store: ZelavisServiceStore,
): OAuthConnectionStore {
  return {
    async read(provider) {
      const value = await store.get(connectionKey(provider));
      return isConnection(value) ? value : undefined;
    },
    async list() {
      const records = await store.list();
      return records
        .filter((record) => record.key.startsWith(KEY_PREFIX))
        .map((record) => record.value as unknown)
        .filter(isConnection)
        .sort((left: OAuthConnection, right: OAuthConnection) =>
          left.provider.localeCompare(right.provider),
        );
    },
    async write(connection) {
      await store.set(
        connectionKey(connection.provider),
        connection as unknown as ZelavisSystemStoreValue,
      );
    },
    async remove(provider) {
      return store.delete(connectionKey(provider));
    },
  };
}

function readEnv(name: string): string | undefined {
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name];
  return value?.trim() ? value.trim() : undefined;
}

/**
 * Reads a connection an operator configured through the environment.
 *
 * Present so a Platform can be brought up with sign-in already working —
 * a container that must come up configured has nowhere to click. Anything
 * stored through the API wins, so a value set once in the environment does not
 * quietly override what an operator changed later.
 */
export function environmentConnection(
  provider: string,
): OAuthConnection | undefined {
  const key = provider.toUpperCase().replaceAll(/[^A-Z0-9]+/gu, "_");
  const clientId = readEnv(`ZELAVIS_AUTH_${key}_CLIENT_ID`);
  const redirectUri = readEnv(`ZELAVIS_AUTH_${key}_REDIRECT_URI`);
  if (!clientId || !redirectUri) return undefined;

  const scopes = readEnv(`ZELAVIS_AUTH_${key}_SCOPES`)
    ?.split(/[\s,]+/u)
    .filter(Boolean);

  return {
    provider,
    clientId,
    ...(readEnv(`ZELAVIS_AUTH_${key}_CLIENT_SECRET`)
      ? { clientSecret: readEnv(`ZELAVIS_AUTH_${key}_CLIENT_SECRET`) }
      : {}),
    redirectUri,
    ...(scopes?.length ? { scopes } : {}),
    enabled: true,
    updatedAt: new Date(0).toISOString(),
  };
}
