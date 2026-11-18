import * as Schema from "effect/Schema";
import type { ZelavisServiceRegistryEntry } from "../../service.js";
import { parseUrl } from "../lib/oauth/redemption.js";

/** A plugin supplies issuer metadata. The operator supplies this installation's client credentials. */
export const OAUTH_PROVIDER_CAPABILITY = "zelavis/auth:oauth";

const Definition = Schema.Struct({
  name: Schema.String,
  title: Schema.optional(Schema.String),
  issuer: Schema.String,
  scopes: Schema.optional(Schema.Array(Schema.String)),
});
export type OAuthProviderDefinition = typeof Definition.Type;
const decodeDefinitions = Schema.decodeUnknownExit(Schema.Struct({ oauthProviders: Schema.Array(Definition) }));

function valid(definition: OAuthProviderDefinition): boolean {
  const issuer = parseUrl(definition.issuer);
  return /^[a-z][a-z0-9-]{0,30}$/u.test(definition.name) &&
    !["google", "apple", "github", "providers", "connections"].includes(definition.name) &&
    issuer?.protocol === "https:" && !issuer.username && !issuer.password && !issuer.search && !issuer.hash;
}

export function defineOAuthProviders(name: string, providers: ReadonlyArray<OAuthProviderDefinition>) {
  if (providers.length === 0 || providers.some((provider) => !valid(provider)) || new Set(providers.map(({ name }) => name)).size !== providers.length) {
    throw new TypeError(`${name} must define unique OAuth providers with HTTPS issuer URLs.`);
  }
  return Object.freeze({
    name,
    kind: "plugin" as const,
    capabilities: [OAUTH_PROVIDER_CAPABILITY] as const,
    service: { oauthProviders: providers.map((provider) => ({ ...provider })) },
  });
}

export function collectOAuthProviders<T>(registry: ReadonlyArray<Readonly<ZelavisServiceRegistryEntry<T>>>): ReadonlyMap<string, OAuthProviderDefinition> {
  const providers = new Map<string, OAuthProviderDefinition>();
  for (const { status, service } of registry) {
    if (status !== "installed" || service.kind !== "plugin" || !service.capabilities?.includes(OAUTH_PROVIDER_CAPABILITY)) continue;
    const definitions = decodeDefinitions(service.service);
    if (definitions._tag !== "Success") continue;
    for (const provider of definitions.value.oauthProviders) {
      if (valid(provider) && !providers.has(provider.name)) providers.set(provider.name, provider);
    }
  }
  return providers;
}
