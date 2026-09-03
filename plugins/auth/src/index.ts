import type { AuthApi, AuthMethodContext, AuthMethodPlugin } from "zelavis/app/auth";
import {
  createConnectionStore,
  environmentConnection,
  publicConnection,
  type OAuthConnection,
  type OAuthConnectionStore,
  type PublicOAuthConnection,
} from "./connections.js";
import {
  OAUTH_PROVIDER_CAPABILITY,
  type OAuthProviderDefinition,
} from "./contract.js";
import { createAuthorizationCodeFlow } from "./provider.js";
import { builtInOAuthProviders } from "./providers.js";

export * from "./contract.js";
export * from "./providers.js";
export * from "./connections.js";
export * from "./provider.js";

/**
 * OAuth and OpenID Connect sign-in for Zelavis.
 *
 * Core auth owns accounts, sessions, credentials, and permissions, and accepts
 * credential providers. This is the layer above: it finds OAuth provider
 * definitions from plugins declaring `@zelavis/auth:oauth`, pairs each with
 * the credentials an operator configured, and registers the result with core
 * auth.
 *
 * The two halves come from different people, which is why they are separate. A
 * provider plugin knows an identity provider's endpoints and claim shapes and
 * can ship them; only the operator has the client id and secret their
 * installation was issued. A package that needed the second could never be
 * installed, only composed in code — and services are not composed any more.
 */

function readOAuthProviders(
  registry: AuthMethodContext["registry"],
): Map<string, OAuthProviderDefinition> {
  const providers = new Map<string, OAuthProviderDefinition>();

  for (const entry of registry) {
    if (entry.status !== "installed") continue;
    if (!entry.service.capabilities?.includes(OAUTH_PROVIDER_CAPABILITY)) continue;

    const declared = (
      entry.service.service as
        | { oauthProviders?: readonly OAuthProviderDefinition[] }
        | undefined
    )?.oauthProviders;
    if (!Array.isArray(declared)) continue;

    for (const definition of declared) {
      if (!definition?.name?.trim()) continue;
      // First installed plugin wins. Letting a later one replace a provider
      // that already exists would redirect sign-in for a name accounts are
      // already bound to.
      if (providers.has(definition.name)) continue;
      providers.set(definition.name, definition);
    }
  }

  return providers;
}

export interface ZelavisAuthOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export function zelavisAuthService(options: ZelavisAuthOptions = {}) {
  let definitions = new Map<string, OAuthProviderDefinition>();
  let connections: OAuthConnectionStore | undefined;

  async function connectionFor(
    provider: string,
  ): Promise<OAuthConnection | undefined> {
    // Stored configuration wins over the environment, so a value set once at
    // deploy time does not silently override what an operator changed later.
    const stored = await connections?.read(provider);
    return stored ?? environmentConnection(provider);
  }

  // Core's Authorization Code contract is synchronous — it reads `redirectUri`
  // as a property and builds the URL without awaiting — so the configuration
  // is held in memory and refreshed whenever it is written. Reloaded at
  // startup, so a restart picks up whatever is stored.
  const configured = new Map<string, OAuthConnection>();

  async function loadConnections(): Promise<void> {
    configured.clear();
    for (const [name] of definitions) {
      const connection = (await connections?.read(name)) ?? environmentConnection(name);
      if (connection) configured.set(name, connection);
    }
  }

  function activeConnection(provider: string): OAuthConnection {
    const connection = configured.get(provider);
    if (!connection?.enabled) {
      // The same message whether a provider is unconfigured or deliberately
      // switched off: which one it is tells an anonymous caller about the
      // installation's setup.
      throw new TypeError(`${provider} sign-in is not available on this installation.`);
    }
    return connection;
  }

  const method: AuthMethodPlugin = {
    name: "@zelavis/auth",
    async register(auth: AuthApi, context?: AuthMethodContext) {
      definitions = readOAuthProviders(context?.registry ?? []);
      // The providers this package ships go in last, so a plugin someone
      // installed for the same name keeps its own definition rather than
      // being displaced by a built-in one.
      for (const definition of builtInOAuthProviders) {
        if (!definitions.has(definition.name)) {
          definitions.set(definition.name, definition);
        }
      }
      connections = context?.store
        ? createConnectionStore(context.store as never)
        : undefined;
      await loadConnections();

      for (const [name, definition] of definitions) {
        // Registered with core auth, which owns the flow: it holds the state
        // and PKCE verifier, calls in for the authorization URL, and calls
        // back to exchange the code. This plugin only knows how to talk to the
        // provider.
        auth.authentication.registerProvider({
          name,
          authorizationCode: {
            get redirectUri() {
              return activeConnection(name).redirectUri;
            },
            createAuthorizationUrl(input) {
              return createAuthorizationCodeFlow(
                definition,
                activeConnection(name),
                options,
              ).createAuthorizationUrl(input);
            },
            exchange(input) {
              return createAuthorizationCodeFlow(
                definition,
                activeConnection(name),
                options,
              ).exchange(input);
            },
          },
        });
      }
    },
  };

  const api = {
    async listProviders(): Promise<
      readonly (PublicOAuthConnection & { title?: string; configured: boolean })[]
    > {
      const listed = [];
      for (const [name, definition] of definitions) {
        const connection = await connectionFor(name);
        listed.push({
          ...(connection
            ? publicConnection(connection)
            : {
                provider: name,
                clientId: "",
                redirectUri: "",
                enabled: false,
                updatedAt: new Date(0).toISOString(),
                hasClientSecret: false,
              }),
          ...(definition.title ? { title: definition.title } : {}),
          configured: Boolean(connection),
        });
      }
      return listed;
    },

    async configure(
      provider: string,
      input: unknown,
    ): Promise<PublicOAuthConnection | undefined> {
      if (!definitions.has(provider)) return undefined;
      if (!connections) {
        throw new TypeError(
          "This installation has no durable store, so OAuth configuration cannot be saved.",
        );
      }
      const body = (input ?? {}) as Partial<OAuthConnection>;
      if (typeof body.clientId !== "string" || !body.clientId.trim()) {
        throw new TypeError("A clientId is required.");
      }
      if (typeof body.redirectUri !== "string" || !body.redirectUri.trim()) {
        throw new TypeError("A redirectUri is required.");
      }
      let redirect: URL;
      try {
        redirect = new URL(body.redirectUri);
      } catch {
        throw new TypeError("The redirectUri must be an absolute URL.");
      }
      if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
        // The authorization code arrives on this URL. Over plaintext anyone on
        // the path can take it, and a code is enough to complete a sign-in.
        throw new TypeError(
          "The redirectUri must use https, except on localhost for development.",
        );
      }

      const existing = await connections.read(provider);
      const connection: OAuthConnection = {
        provider,
        clientId: body.clientId.trim(),
        // An omitted secret keeps the stored one, so an operator editing a
        // redirect URI does not have to re-enter a secret the API never
        // showed them.
        ...(typeof body.clientSecret === "string" && body.clientSecret
          ? { clientSecret: body.clientSecret }
          : existing?.clientSecret
            ? { clientSecret: existing.clientSecret }
            : {}),
        redirectUri: redirect.toString(),
        ...(Array.isArray(body.scopes)
          ? { scopes: body.scopes.filter((scope) => typeof scope === "string") }
          : {}),
        enabled: body.enabled !== false,
        updatedAt: new Date().toISOString(),
      };
      await connections.write(connection);
      configured.set(provider, connection);
      return publicConnection(connection);
    },

    async remove(provider: string): Promise<boolean> {
      const removed = (await connections?.remove(provider)) ?? false;
      // The environment may still define it, so the cache is reloaded rather
      // than the entry simply dropped.
      const fallback = environmentConnection(provider);
      if (fallback) configured.set(provider, fallback);
      else configured.delete(provider);
      return removed;
    },
  };

  return Object.freeze({
    name: "@zelavis/auth",
    kind: "plugin" as const,
    capabilities: Object.freeze(["zelavis/auth:credentials", "api:routes"]),
    // Not `/auth/oauth`: core auth already serves the Authorization Code flow
    // there — start, callback, and account linking, with the PKCE and nonce
    // state that goes with them. This plugin supplies the providers that flow
    // runs on, so it owns configuration and nothing else.
    basePath: "/auth/connections",
    marketplace: Object.freeze({
      title: "OAuth sign-in",
      summary: "Sign in with an external identity provider.",
      categories: Object.freeze(["auth"]),
    }),
    service: Object.freeze({ ...method, ...api }),
    api: {
      v1: [
        {
          id: "auth.oauth.providers.list",
          method: "GET" as const,
          path: "/providers",
          access: { permissions: ["auth.manage"] },
          spec: {
            operationId: "listOAuthProviders",
            summary: "List installed OAuth providers and their configuration",
            tags: ["auth"],
            responses: { 200: { description: "Installed providers" } },
          },
          handler: async ({ service }: any) => ({
            status: 200,
            body: { providers: await service.listProviders() },
          }),
        },
        {
          id: "auth.oauth.providers.configure",
          method: "PUT" as const,
          path: "/providers/:provider",
          access: { permissions: ["auth.manage"] },
          spec: {
            operationId: "configureOAuthProvider",
            summary: "Configure an installed OAuth provider",
            tags: ["auth"],
            pathParams: {
              provider: { type: "string", required: true, description: "Provider name" },
            },
            requestBody: {
              required: true,
              schema: { type: "object", additionalProperties: true },
            },
            responses: {
              200: { description: "Connection saved" },
              400: { description: "Invalid connection details" },
              404: { description: "No such provider is installed" },
            },
          },
          handler: async ({ service, params, body }: any) => {
            try {
              const saved = await service.configure(params.provider, body);
              return saved
                ? { status: 200, body: { connection: saved } }
                : {
                    status: 404,
                    body: {
                      error: `No installed plugin defines "${params.provider}".`,
                    },
                  };
            } catch (error) {
              return {
                status: 400,
                body: {
                  error: error instanceof Error ? error.message : "Invalid request.",
                },
              };
            }
          },
        },
        {
          id: "auth.oauth.providers.remove",
          method: "DELETE" as const,
          path: "/providers/:provider",
          access: { permissions: ["auth.manage"] },
          spec: {
            operationId: "removeOAuthProvider",
            summary: "Remove an OAuth provider's configuration",
            tags: ["auth"],
            pathParams: {
              provider: { type: "string", required: true, description: "Provider name" },
            },
            responses: { 204: { description: "Connection removed" } },
          },
          handler: async ({ service, params }: any) => {
            await service.remove(params.provider);
            return { status: 204 };
          },
        },
      ],
    },
  });
}

export default zelavisAuthService();
