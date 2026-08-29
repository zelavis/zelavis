import type { ZelavisPrincipal } from "./contracts.js";
import {
  readAuthorizationCredential,
  ZelavisAuthenticationError,
  type ZelavisRequestAuthenticator,
} from "./authentication.js";

export function createBasicAuthenticator(options: {
  name?: string;
  realm: string;
  verify(input: { username: string; password: string; request: Request }):
    | ZelavisPrincipal
    | undefined
    | Promise<ZelavisPrincipal | undefined>;
}): ZelavisRequestAuthenticator {
  const challenge = { scheme: "Basic", parameters: { realm: options.realm, charset: "UTF-8" } };
  return {
    name: options.name ?? "basic",
    async authenticate(context) {
      const encoded = readAuthorizationCredential(context.request, "Basic");
      if (!encoded) return undefined;
      try {
        const decoded = new TextDecoder().decode(
          Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        );
        const separator = decoded.indexOf(":");
        if (separator < 0) throw new Error("missing separator");
        const principal = await options.verify({
          username: decoded.slice(0, separator),
          password: decoded.slice(separator + 1),
          request: context.request,
        });
        if (!principal) throw new Error("invalid credentials");
        return principal;
      } catch (cause) {
        throw new ZelavisAuthenticationError("Invalid Basic credentials.", { challenge, cause });
      }
    },
  };
}
