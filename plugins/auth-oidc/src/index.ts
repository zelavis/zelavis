import {
  createJwksAuthenticator,
  type ZelavisPrincipal,
} from "zelavis/core";

/**
 * Accepts JWT bearer tokens issued by an external OpenID Connect provider.
 *
 * This is machine-to-machine access: a caller already holding a token from the
 * issuer presents it, and the token is verified against the issuer's key set.
 * No sign-in happens here and no account is created.
 *
 * Browser sign-in is a different thing and lives in `@zelavis/auth`, which
 * runs the Authorization Code flow through core auth and creates real
 * accounts. This package used to carry a second implementation of that flow;
 * two implementations of one exchange drift, and only one of them can be the
 * one an operator has configured.
 */
export interface OidcBearerPluginOptions {
  providerName?: string;
  issuer: string;
  audience: string | readonly string[];
  jwksUrl: string | URL;
  algorithms?: readonly string[];
  mapPrincipal?: (claims: Readonly<Record<string, unknown>>) =>
    | ZelavisPrincipal
    | undefined
    | Promise<ZelavisPrincipal | undefined>;
}

export function oidcBearerService(options: OidcBearerPluginOptions) {
  const issuer = options.issuer.replace(/\/$/u, "");

  return Object.freeze({
    name: "@zelavis/auth-oidc",
    kind: "plugin" as const,
    capabilities: Object.freeze(["zelavis/auth:credentials"]),
    authenticators: [
      createJwksAuthenticator({
        name: options.providerName ?? "oidc",
        issuer,
        audience: options.audience,
        algorithms: options.algorithms ?? ["RS256", "ES256", "EdDSA"],
        jwksUrl: options.jwksUrl,
        async mapPrincipal(payload) {
          if (options.mapPrincipal) return options.mapPrincipal(payload);
          if (typeof payload.sub !== "string" || !payload.sub) return undefined;
          return {
            id: payload.sub,
            type: "user",
            metadata: { issuer: payload.iss, authentication: "oidc" },
          };
        },
      }),
    ],
    service: { name: options.providerName ?? "oidc", register() {} },
  });
}
