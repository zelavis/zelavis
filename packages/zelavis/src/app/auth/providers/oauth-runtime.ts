import type { AuthApi, AuthMethodContext, AuthMethodPlugin } from "../core/types.js";
import { AuthValidationError } from "../core/errors.js";
import {
  createConnectionStore,
  environmentConnection,
  publicConnection,
  type OAuthConnection,
  type PublicOAuthConnection,
} from "./oauth-connections.js";
import {
  OAUTH_PROVIDER_CAPABILITY,
  type OAuthProviderDefinition,
} from "./oauth-contract.js";
import { builtInOAuthProviders } from "./oauth-definitions.js";
import { discoverOidcProvider } from "./oauth-discovery.js";
import { createAuthorizationCodeFlow } from "./oauth-flow.js";

export interface OAuthProviderRuntimeOptions {
  fetch?: typeof globalThis.fetch;
  /** Platform deployments may opt into ZELAVIS_AUTH_* bootstrap variables. */
  environmentConnections?: boolean;
}

export interface OAuthConnectionAdmin {
  list(): Promise<readonly (PublicOAuthConnection & { title?: string; configured: boolean })[]>;
  configure(provider: string, input: unknown): Promise<PublicOAuthConnection | undefined>;
  remove(provider: string): Promise<void>;
}

/**
 * One runtime-local OAuth controller.
 *
 * Provider definitions are code, while client credentials are installation or
 * Project state. Keeping both maps in this closure prevents one Project runtime
 * from replacing another Project's provider configuration in the same process.
 */
export function createOAuthProviderRuntime(
  options: OAuthProviderRuntimeOptions = {},
): { method: AuthMethodPlugin; connections: OAuthConnectionAdmin } {
  let state:
    | {
        api: AuthApi;
        definitions: Map<string, OAuthProviderDefinition>;
        connections: ReturnType<typeof createConnectionStore> | undefined;
        active: Map<string, OAuthConnection>;
        register(definition: OAuthProviderDefinition): void;
      }
    | undefined;

  const register = async (
    api: AuthApi,
    context: AuthMethodContext | undefined,
  ): Promise<void> => {
    const definitions = new Map<string, OAuthProviderDefinition>();
    for (const entry of context?.registry ?? []) {
      if (entry.status !== "installed") continue;
      if (!entry.service.capabilities?.includes(OAUTH_PROVIDER_CAPABILITY)) continue;
      const declared = (
        entry.service.service as
          | { oauthProviders?: readonly OAuthProviderDefinition[] }
          | undefined
      )?.oauthProviders;
      if (!Array.isArray(declared)) continue;
      for (const definition of declared) {
        if (definition?.name && !definitions.has(definition.name)) {
          definitions.set(definition.name, definition);
        }
      }
    }
    for (const definition of builtInOAuthProviders) {
      if (!definitions.has(definition.name)) definitions.set(definition.name, definition);
    }

    const connections = context?.store
      ? createConnectionStore(context.store as never)
      : undefined;
    const active = new Map<string, OAuthConnection>();
    for (const stored of (await connections?.list()) ?? []) {
      active.set(stored.provider, stored);
      if (!definitions.has(stored.provider) && stored.discovered) {
        definitions.set(
          stored.provider,
          stored.discovered as OAuthProviderDefinition,
        );
      }
    }
    if (options.environmentConnections) {
      for (const name of definitions.keys()) {
        if (active.has(name)) continue;
        const fromEnvironment = environmentConnection(name);
        if (fromEnvironment) active.set(name, fromEnvironment);
      }
    }

    const requireConnection = (name: string): OAuthConnection => {
      const connection = active.get(name);
      if (!connection?.enabled) {
        throw new TypeError(`${name} sign-in is not available on this installation.`);
      }
      return connection;
    };

    const registerDefinition = (definition: OAuthProviderDefinition) => {
      const name = definition.name;
      api.authentication.registerProvider({
        name,
        authorizationCode: {
          get redirectUri() {
            return requireConnection(name).redirectUri;
          },
          createAuthorizationUrl(input) {
            return createAuthorizationCodeFlow(
              definition,
              requireConnection(name),
              options,
            ).createAuthorizationUrl(input);
          },
          exchange(input) {
            return createAuthorizationCodeFlow(
              definition,
              requireConnection(name),
              options,
            ).exchange(input);
          },
        },
      });
    };
    for (const definition of definitions.values()) registerDefinition(definition);

    state = {
      api,
      definitions,
      connections,
      active,
      register: registerDefinition,
    };
  };

  const connections: OAuthConnectionAdmin = {
    async configure(provider, input) {
      if (!state) return undefined;
      const body = (input ?? {}) as Partial<OAuthConnection>;
      let discovered: OAuthProviderDefinition | undefined;
      if (typeof body.issuer === "string" && body.issuer.trim()) {
        discovered = await discoverOidcProvider(body.issuer.trim(), {
          name: provider,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        state.definitions.set(provider, discovered);
        state.register(discovered);
      }

      if (!state.definitions.has(provider)) return undefined;
      if (!state.connections) {
        throw new AuthValidationError(
          "This auth runtime has no durable provider settings store.",
        );
      }
      if (typeof body.clientId !== "string" || !body.clientId.trim()) {
        throw new AuthValidationError("A clientId is required.");
      }
      if (typeof body.redirectUri !== "string" || !body.redirectUri.trim()) {
        throw new AuthValidationError("A redirectUri is required.");
      }
      let redirect: URL;
      try {
        redirect = new URL(body.redirectUri);
      } catch {
        throw new AuthValidationError("The redirectUri must be an absolute URL.");
      }
      if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
        throw new AuthValidationError(
          "The redirectUri must use https, except on localhost for development.",
        );
      }

      const existing = await state.connections.read(provider);
      const connection: OAuthConnection = {
        provider,
        clientId: body.clientId.trim(),
        ...(typeof body.clientSecret === "string" && body.clientSecret
          ? { clientSecret: body.clientSecret }
          : existing?.clientSecret
            ? { clientSecret: existing.clientSecret }
            : {}),
        redirectUri: redirect.toString(),
        ...(discovered
          ? { issuer: discovered.issuer, discovered }
          : existing?.discovered
            ? { issuer: existing.issuer, discovered: existing.discovered }
            : {}),
        ...(Array.isArray(body.scopes)
          ? { scopes: body.scopes.filter((scope) => typeof scope === "string") }
          : existing?.scopes
            ? { scopes: existing.scopes }
            : {}),
        enabled: body.enabled !== false,
        updatedAt: new Date().toISOString(),
      };
      await state.connections.write(connection);
      state.active.set(provider, connection);
      return publicConnection(connection);
    },

    async list() {
      if (!state) return [];
      return [...state.definitions].map(([name, definition]) => {
        const connection = state!.active.get(name);
        return {
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
        };
      });
    },

    async remove(provider) {
      if (!state) return;
      await state.connections?.remove(provider);
      const fallback = options.environmentConnections
        ? environmentConnection(provider)
        : undefined;
      if (fallback) state.active.set(provider, fallback);
      else state.active.delete(provider);
    },
  };

  return {
    method: {
      name: "zelavis/auth:oauth",
      register,
    },
    connections,
  };
}
