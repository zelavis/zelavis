import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyOptions,
  type JWTPayload,
} from "jose";
import type { ZelavisPrincipal } from "./contracts.js";
import {
  readAuthorizationCredential,
  ZelavisAuthenticationError,
  type ZelavisRequestAuthenticator,
} from "./authentication.js";

type JwtKey = Parameters<typeof jwtVerify>[1];

export interface ZelavisJwtAuthenticatorOptions {
  name?: string;
  key: JwtKey | ReturnType<typeof createRemoteJWKSet>;
  issuer: string | readonly string[];
  audience: string | readonly string[];
  algorithms: readonly string[];
  mapPrincipal(payload: JWTPayload, protectedHeader: Readonly<Record<string, unknown>>):
    | ZelavisPrincipal
    | undefined
    | Promise<ZelavisPrincipal | undefined>;
}

export function createJwtAuthenticator(
  options: ZelavisJwtAuthenticatorOptions,
): ZelavisRequestAuthenticator {
  if (!options.algorithms.length) throw new TypeError("JWT authentication requires an algorithm allow-list.");
  const verifyOptions: JWTVerifyOptions = {
    issuer: Array.isArray(options.issuer) ? [...options.issuer] : options.issuer as string,
    audience: Array.isArray(options.audience) ? [...options.audience] : options.audience as string,
    algorithms: [...options.algorithms],
  };
  return {
    name: options.name ?? "jwt",
    async authenticate(context) {
      const token = readAuthorizationCredential(context.request, "Bearer");
      if (!token) return undefined;
      if (token.split(".").length !== 3) return undefined;
      try {
        const verified = await jwtVerify(token, options.key, verifyOptions);
        const principal = await options.mapPrincipal(verified.payload, verified.protectedHeader);
        if (!principal) throw new Error("JWT does not resolve to a principal.");
        return principal;
      } catch (cause) {
        throw new ZelavisAuthenticationError("Invalid bearer token.", {
          challenge: { scheme: "Bearer", parameters: { error: "invalid_token" } },
          cause,
        });
      }
    },
  };
}

export function createJwksAuthenticator(options: Omit<ZelavisJwtAuthenticatorOptions, "key"> & {
  jwksUrl: URL | string;
  headers?: HeadersInit;
}): ZelavisRequestAuthenticator {
  const headers = new Headers(options.headers);
  return createJwtAuthenticator({
    ...options,
    key: createRemoteJWKSet(new URL(options.jwksUrl), {
      headers: Object.fromEntries(headers.entries()),
    }),
  });
}
