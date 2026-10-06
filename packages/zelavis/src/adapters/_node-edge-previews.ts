import { Effect } from "effect";
import type { ZelavisEdgePreviewHost } from "../edge/previews.js";
import { createNodeHttpServer } from "../core/runtime/node-http.js";
import { evaluate, integration, IntegrationFailure, present, presentOperations } from "../core/runtime/effect-boundary.js";
import { closeNodeServer } from "../runtimes/node.js";

/** A separate HTTP origin per Project; no Project process is made public. */
export function createNodeEdgePreviewHost(host: string): ZelavisEdgePreviewHost {
  return presentOperations({
    open: Effect.fn("EdgePreviewHost.open")(function* ({ port, fetch }: Parameters<ZelavisEdgePreviewHost["open"]>[0]) {
      const server = createNodeHttpServer({ fetch: request => present(Effect.gen(function* () {
        const rewritten = yield* evaluate(() => {
          const url = new URL(request.url); url.protocol = "http:";
          return new Request(url, request);
        });
        return yield* integration(() => fetch(rewritten));
      })) });
      return yield* Effect.gen(function* () {
        yield* Effect.callback<void, IntegrationFailure>((resume, signal) => {
          const failed = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
          server.once("error", failed);
          server.listen({ port, host, signal }, () => { server.off("error", failed); resume(Effect.void); });
          return Effect.sync(() => server.off("error", failed));
        });
        const address = yield* evaluate(() => {
          const bound = server.address();
          if (!bound || typeof bound === "string") throw new Error("Preview has no TCP address.");
          return bound;
        });
        return { port: address.port, close: () => closeNodeServer(server, { gracePeriodMs: 1000 }) };
      }).pipe(Effect.onError(() => integration(() => closeNodeServer(server)).pipe(Effect.ignore)));
    }),
  });
}
