import { Effect } from "effect";
import { IntegrationFailure, evaluate, integration, present, unwrapFailure } from "./effect-boundary.js";
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
    authenticate(context) {
      return present(Effect.gen(function* () {
        const encoded = readAuthorizationCredential(context.request, "Basic");
        if (!encoded) return undefined;
        return yield* evaluate(() => {
          const decoded = new TextDecoder().decode(
            Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
          );
          const separator = decoded.indexOf(":");
          if (separator < 0) throw new Error("missing separator");
          return { decoded, separator };
        }).pipe(
          Effect.flatMap(({ decoded, separator }) => integration(() => options.verify({
            username: decoded.slice(0, separator),
            password: decoded.slice(separator + 1),
            request: context.request,
          }))),
          Effect.flatMap((principal) => principal
            ? Effect.succeed(principal)
            : Effect.fail(new IntegrationFailure(new Error("invalid credentials")))),
          Effect.mapError((failure) => new IntegrationFailure(new ZelavisAuthenticationError("Invalid Basic credentials.", { challenge, cause: unwrapFailure(failure) }))),
        );
      }));
    },
  };
}
