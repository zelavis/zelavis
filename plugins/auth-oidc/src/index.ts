import {
  createJwksAuthenticator,
  type ZelavisPrincipal,
} from "zelavis/core";
import { defineService } from "zelavis/service";

export interface OidcBearerPluginOptions {
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
  return defineService({
    name: "@zelavis/auth-oidc",
    kind: "provider",
    capabilities: ["provider:auth"],
    authenticators: [createJwksAuthenticator({
      name: "oidc",
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
    })],
  });
}
