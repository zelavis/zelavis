/**
 * Operator-managed OAuth connections (Zelavis-own; adapted from the prior engine's OAuth connection store).
 *
 * A connection is an operator's credentials for one identity provider. The client id and secret are issued per
 * installation by the provider, so they cannot ship in a package: they are stored in the runtime's Auth partition,
 * the secret sealed with the runtime's master secret and never returned or logged. Google, Apple and GitHub are
 * connected by their name; any OpenID Connect issuer is connected under a name of the operator's choice by pasting
 * its issuer URL.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { integration } from "../../core/runtime/effect-boundary.js";
import { decryptSecret, encryptSecret } from "../../edge/acme-crypto.js";
import type { AuthFailure } from "../core/errors.js";
import { type OAuthFetch } from "../lib/oauth/callback.js";
import { parseUrl } from "../lib/oauth/redemption.js";
import { callbackPath } from "../lib/oauth/constants.js";
import { type AuthRuntime, type AuthTxBase, NO_REQUEST } from "../runtime/index.js";
import { importApplePrivateKey } from "../apple/secret.js";
import { DISCOVERY_MAX_AGE_MS, discoverIssuer } from "./discovery.js";
import type { OAuthProviderDefinition } from "./plugins.js";
import { type DiscoveredIssuer, oauthConnectionsTables } from "./tables.js";

/** The providers with a module of their own: connected by name, with no issuer. */
export const BUILT_IN_PROVIDERS = [
  { name: "google", title: "Google" },
  { name: "apple", title: "Apple" },
  { name: "github", title: "GitHub" },
] as const;

export type BuiltInProvider = (typeof BUILT_IN_PROVIDERS)[number]["name"];

export const isBuiltInProvider = (name: string): name is BuiltInProvider => BUILT_IN_PROVIDERS.some((provider) => provider.name === name);

/** `connections` and `providers` are route segments below `/auth/oauth`. */
const RESERVED = new Set(["connections", "providers"]);
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export const validProviderName = (name: string) => PROVIDER_NAME.test(name) && !RESERVED.has(name);

/** The operator's input is not acceptable; the message says why and is safe to show. */
export class OAuthConnectionInvalid extends Schema.TaggedError<OAuthConnectionInvalid>()("OAuthConnectionInvalid", {
  message: Schema.String,
}) {}

const invalid = (message: string) => new OAuthConnectionInvalid({ message });

/**
 * An operator's credentials for one identity provider, with its secret open. Never leaves the runtime: the API
 * returns {@link PublicOAuthConnection}.
 */
export interface OAuthConnection {
  readonly provider: string;
  /** The OIDC issuer a generic provider was discovered from. */
  readonly issuer?: string | undefined;
  /** Endpoints read from the issuer, cached so a restart needs no network. */
  readonly discovered?: DiscoveredIssuer | undefined;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly teamId?: string | undefined;
  readonly keyId?: string | undefined;
  readonly redirectUri: string;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** A connection as the API returns it. Never carries the secret. */
export interface PublicOAuthConnection {
  readonly provider: string;
  readonly issuer?: string;
  readonly clientId: string;
  readonly teamId?: string;
  readonly keyId?: string;
  readonly redirectUri: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly updatedAt: string;
  /** Whether a secret is stored, which is all a caller needs to know. */
  readonly hasClientSecret: boolean;
}

export function publicConnection(connection: OAuthConnection): PublicOAuthConnection {
  // Built by naming the fields to keep rather than deleting the secret from a
  // copy: a future field added to the stored shape then has to be listed here
  // before it can leak.
  return {
    provider: connection.provider,
    ...(connection.issuer ? { issuer: connection.issuer } : {}),
    clientId: connection.clientId,
    ...(connection.teamId ? { teamId: connection.teamId } : {}),
    ...(connection.keyId ? { keyId: connection.keyId } : {}),
    redirectUri: connection.redirectUri,
    ...(connection.scopes ? { scopes: connection.scopes } : {}),
    enabled: connection.enabled,
    updatedAt: connection.updatedAt,
    hasClientSecret: Boolean(connection.clientSecret),
  };
}

const readEnv = (environment: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const value = environment[name];
  return value?.trim() ? value.trim() : undefined;
};

/**
 * Reads a connection an operator configured through the environment.
 *
 * Present so a Platform can be brought up with sign-in already working: a container that must come up configured
 * has nowhere to click. Anything stored through the API wins, so a value set once in the environment does not
 * quietly override what an operator changed later. Only the built-in providers read it.
 */
export function environmentConnection(environment: Readonly<Record<string, string | undefined>>, provider: string): OAuthConnection | undefined {
  if (!isBuiltInProvider(provider)) return undefined;
  const key = provider.toUpperCase();
  const clientId = readEnv(environment, `ZELAVIS_AUTH_${key}_CLIENT_ID`);
  const redirectUri = readEnv(environment, `ZELAVIS_AUTH_${key}_REDIRECT_URI`);
  if (!clientId || !redirectUri) return undefined;
  const scopes = readEnv(environment, `ZELAVIS_AUTH_${key}_SCOPES`)?.split(/[\s,]+/u).filter(Boolean);
  return {
    provider,
    clientId,
    clientSecret: readEnv(environment, `ZELAVIS_AUTH_${key}_CLIENT_SECRET`),
    teamId: readEnv(environment, `ZELAVIS_AUTH_${key}_TEAM_ID`),
    keyId: readEnv(environment, `ZELAVIS_AUTH_${key}_KEY_ID`),
    redirectUri,
    ...(scopes?.length ? { scopes } : {}),
    enabled: true,
    updatedAt: new Date(0).toISOString(),
  };
}

/** The key connection secrets are sealed with: bound to its purpose, so no other sealed record decrypts as one. */
export const connectionKey = (masterSecret: string) => `${masterSecret}\u0000zelavis.auth.oauth`;

const ConnectionInput = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  redirectUri: Schema.String,
  issuer: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  teamId: Schema.optional(Schema.String),
  keyId: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
});
const decodeInput = Schema.decodeUnknownExit(ConnectionInput);

export type ConfigureResult =
  | { readonly status: "saved"; readonly connection: PublicOAuthConnection }
  | { readonly status: "unknown" };

export type VersionedOAuthConnection = OAuthConnection & { readonly revision: string };

export interface OAuthConnections {
  /** The connection of a provider, secret open: what is stored, else the environment's. Undefined when there is none. */
  readonly read: (provider: string) => Effect.Effect<VersionedOAuthConnection | undefined, AuthFailure>;
  /** Every built-in provider and every stored connection, secrets never included, with its title. */
  readonly list: () => Effect.Effect<ReadonlyArray<PublicOAuthConnection & { readonly title?: string; readonly configured: boolean }>, AuthFailure>;
  /** Saves a connection. `unknown` when the name is no built-in provider and no issuer was given. */
  readonly configure: (provider: string, input: unknown) => Effect.Effect<ConfigureResult, OAuthConnectionInvalid | AuthFailure>;
  readonly remove: (provider: string) => Effect.Effect<void, AuthFailure>;
  /** Read the connection within the transaction granting authority. */
  readonly isCurrent: (tx: AuthTxBase, provider: string, revision: string) => Effect.Effect<boolean, AuthFailure>;
  /** Reads an OpenID Connect connection's metadata again when it is older than a day; the connection as it then stands. */
  readonly refreshed: (connection: VersionedOAuthConnection) => Effect.Effect<VersionedOAuthConnection, AuthFailure>;
}

export function createConnections(options: {
  readonly runtime: AuthRuntime;
  readonly masterSecret: string;
  readonly fetch: OAuthFetch;
  readonly clock: () => number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly providers?: ReadonlyMap<string, OAuthProviderDefinition> | undefined;
}): OAuthConnections {
  const key = connectionKey(options.masterSecret);
  const table = oauthConnectionsTables.connections;

  type Row = {
    provider: string; revision: string; useEnvironment?: boolean | undefined;
    issuer?: string | undefined; discovered?: DiscoveredIssuer | undefined; clientId: string;
    sealedClientSecret?: Parameters<typeof decryptSecret>[0] | undefined; teamId?: string | undefined; keyId?: string | undefined;
    redirectUri: string; scopes?: ReadonlyArray<string> | undefined; enabled: boolean; updatedAt: string;
  };

  // A secret that cannot be opened (the master secret changed) makes the connection one without a secret, which
  // the provider answers as unavailable; the operator sees `hasClientSecret: false` and saves the secret again.
  const openSecret = (sealed: Parameters<typeof decryptSecret>[0] | undefined, provider: string) =>
    sealed === undefined
      ? Effect.succeed(undefined)
      : Effect.try({ try: () => decryptSecret(sealed, key), catch: () => "unreadable" as const }).pipe(
          Effect.catch(() => Effect.as(Effect.logWarning(`The stored secret of the OAuth connection "${provider}" cannot be opened.`), undefined)),
        );

  const toConnection = Effect.fn("auth.oauth.connections.open")(function* (row: Row) {
    return {
      provider: row.provider,
      revision: row.revision,
      issuer: row.issuer,
      discovered: row.discovered,
      clientId: row.clientId,
      clientSecret: yield* openSecret(row.sealedClientSecret, row.provider),
      teamId: row.teamId,
      keyId: row.keyId,
      redirectUri: row.redirectUri,
      scopes: row.scopes,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    } satisfies VersionedOAuthConnection;
  });

  const find = (tx: AuthTxBase, provider: string) =>
    tx.db.query(table).withIndex("by_provider", (q) => q.eq("provider", provider)).unique();
  const stored = (provider: string) => options.runtime.query(NO_REQUEST, (tx) => find(tx, provider));

  const fromEnvironment = Effect.fn("auth.oauth.connections.fromEnvironment")(function* (provider: string, revision?: string) {
    const connection = environmentConnection(options.environment, provider);
    if (connection === undefined) return undefined;
    // Bind environment flows to the actual configuration across restarts without storing a secret or its raw hash.
    const encoder = new TextEncoder();
    const hmac = yield* integration(() => crypto.subtle.importKey(
      "raw", encoder.encode(`${key}\u0000environment`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    )).pipe(Effect.orDie);
    const digest = yield* integration(() => crypto.subtle.sign("HMAC", hmac, encoder.encode(JSON.stringify([revision, connection])))).pipe(Effect.orDie);
    const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { ...connection, revision: `env:${fingerprint}` };
  });

  const read = Effect.fn("auth.oauth.connections.read")(function* (provider: string) {
    const row = yield* stored(provider);
    return row !== null && !row.useEnvironment ? yield* toConnection(row) : yield* fromEnvironment(provider, row?.revision);
  });

  const isCurrent = Effect.fn("auth.oauth.connections.isCurrent")(function* (tx: AuthTxBase, provider: string, revision: string) {
    const row = yield* find(tx, provider);
    if (row !== null && !row.useEnvironment) return row.enabled && row.revision === revision;
    const fallback = yield* fromEnvironment(provider, row?.revision);
    return fallback?.revision === revision;
  });

  const list = Effect.fn("auth.oauth.connections.list")(function* () {
    const rows = yield* options.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect());
    const byName = new Map<string, OAuthConnection>();
    for (const row of rows) {
      if (!row.useEnvironment) byName.set(row.provider, yield* toConnection(row));
    }
    for (const provider of BUILT_IN_PROVIDERS) {
      if (!byName.has(provider.name)) {
        const fromEnvironment = environmentConnection(options.environment, provider.name);
        if (fromEnvironment !== undefined) byName.set(provider.name, fromEnvironment);
      }
    }
    const names = new Set<string>([...BUILT_IN_PROVIDERS.map((provider) => provider.name), ...options.providers?.keys() ?? [], ...byName.keys()]);
    return [...names]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((name) => {
        const connection = byName.get(name);
        const definition = options.providers?.get(name);
        const title = BUILT_IN_PROVIDERS.find((provider) => provider.name === name)?.title ?? definition?.title ?? name;
        return {
          ...(connection === undefined
            ? { provider: name, ...(definition ? { issuer: definition.issuer } : {}), clientId: "", redirectUri: "", enabled: false, updatedAt: new Date(0).toISOString(), hasClientSecret: false }
            : publicConnection(connection)),
          title,
          configured: connection !== undefined,
        };
      });
  });

  const configure = Effect.fn("auth.oauth.connections.configure")(function* (provider: string, input: unknown) {
    if (!validProviderName(provider)) return { status: "unknown" } as const;
    const decoded = decodeInput(input ?? {});
    if (!Exit.isSuccess(decoded)) return yield* invalid("A clientId and a redirectUri are required.");
    const body = decoded.value;
    const definition = options.providers?.get(provider);
    const enteredIssuer = body.issuer?.trim() || undefined;
    if (definition && enteredIssuer && enteredIssuer.replace(/\/+$/u, "") !== definition.issuer.replace(/\/+$/u, "")) {
      return yield* invalid(`Use the issuer declared by the ${provider} plugin.`);
    }
    const issuer = definition?.issuer ?? enteredIssuer;
    const builtIn = isBuiltInProvider(provider);
    if (builtIn && issuer !== undefined) return yield* invalid(`${provider} is connected by its name; it takes no issuer.`);
    if (!builtIn && issuer === undefined) return { status: "unknown" } as const;
    const clientId = body.clientId.trim();
    if (!clientId) return yield* invalid("A clientId is required.");
    if (!body.redirectUri.trim()) return yield* invalid("A redirectUri is required.");
    const redirect = parseUrl(body.redirectUri);
    if (redirect === null) return yield* invalid("The redirectUri must be an absolute URL.");
    if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]"))) {
      return yield* invalid("The redirectUri must use https, except on localhost for development.");
    }
    // The callback is the route of this runtime that serves the provider; a path that names another provider would
    // register a URL that answers 404 or serves somebody else.
    if (!redirect.pathname.endsWith(callbackPath(provider))) {
      return yield* invalid(`The redirectUri must end with ${callbackPath(provider)}.`);
    }

    const clientSecret = body.clientSecret !== undefined && body.clientSecret !== "" ? body.clientSecret : undefined;
    const now = options.clock();
    const discovered = issuer === undefined
      ? undefined
      : yield* discoverIssuer(options.fetch, issuer, now).pipe(Effect.mapError((failure) => invalid(failure.message)));
    const scopes = body.scopes?.filter((scope) => scope.length > 0);
    const revision = crypto.randomUUID();
    const saved = yield* options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const row = yield* find(tx, provider);
      const teamId = body.teamId?.trim() || row?.teamId;
      const keyId = body.keyId?.trim() || row?.keyId;
      if (provider === "apple" && (!teamId || !keyId)) return yield* invalid("Apple needs a teamId and a keyId.");
      if (clientSecret === undefined && (row?.sealedClientSecret === undefined || row.issuer !== discovered?.issuer)) {
        return yield* invalid(provider === "apple" ? "Apple needs its private key as the client secret." : "A clientSecret is required.");
      }
      if (provider === "apple" && clientSecret !== undefined) {
        yield* importApplePrivateKey(clientSecret).pipe(Effect.mapError((failure) => invalid(failure.message)));
      }
      const next = {
        provider,
        revision,
        clientId,
        redirectUri: redirect.toString(),
        enabled: body.enabled !== false,
        updatedAt: new Date(tx.now).toISOString(),
        sealedClientSecret: clientSecret !== undefined ? { ...encryptSecret(clientSecret, key) } : row?.sealedClientSecret,
        teamId,
        keyId,
        issuer: discovered?.issuer,
        discovered,
        scopes: scopes ?? row?.scopes ?? definition?.scopes,
      };
      if (row === null) yield* tx.db.insert(table, next);
      else yield* tx.db.replace(table, row._id, next);
      return next;
    }));
    return { status: "saved", connection: publicConnection(yield* toConnection(saved)) } as const;
  });

  const remove = Effect.fn("auth.oauth.connections.remove")(function* (provider: string) {
    if (!validProviderName(provider)) return;
    const revision = crypto.randomUUID();
    yield* options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const row = yield* find(tx, provider);
      if (!isBuiltInProvider(provider)) {
        if (row !== null) yield* tx.db.delete(table, row._id);
        return;
      }
      if (environmentConnection(options.environment, provider) === undefined && row === null) return;
      const fallback = { provider, revision, useEnvironment: true, clientId: "", redirectUri: "", enabled: false, updatedAt: new Date(tx.now).toISOString() };
      if (row === null) yield* tx.db.insert(table, fallback);
      else yield* tx.db.replace(table, row._id, fallback);
    }));
  });

  // Metadata read again when it is older than a day, kept as stored when the issuer cannot be reached now.
  const refreshed = Effect.fn("auth.oauth.connections.refreshed")(function* (connection: VersionedOAuthConnection) {
    const { issuer, discovered } = connection;
    if (issuer === undefined || discovered === undefined || options.clock() - discovered.discoveredAt < DISCOVERY_MAX_AGE_MS) return connection;
    const fresh = yield* discoverIssuer(options.fetch, issuer, options.clock()).pipe(Effect.option);
    if (fresh._tag === "None") return connection;
    const metadata = fresh.value;
    const trustChanged = metadata.issuer !== discovered.issuer || metadata.authorizationEndpoint !== discovered.authorizationEndpoint
      || metadata.tokenEndpoint !== discovered.tokenEndpoint || metadata.jwksUrl !== discovered.jwksUrl
      || JSON.stringify([...(metadata.algorithms ?? [])].sort()) !== JSON.stringify([...(discovered.algorithms ?? [])].sort());
    const revision = trustChanged ? crypto.randomUUID() : connection.revision;
    const saved = yield* options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const row = yield* find(tx, connection.provider);
      if (row === null || row.revision !== connection.revision || row.discovered?.discoveredAt !== discovered.discoveredAt) return false;
      yield* tx.db.patch(table, row._id, { discovered: metadata, revision });
      return true;
    }));
    return saved ? { ...connection, discovered: metadata, revision } : connection;
  });

  return { read, list, configure, remove, refreshed, isCurrent };
}
