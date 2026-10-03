import type { ZelavisEdgePreviewHost } from "../edge/previews.js";
import { createNodeHttpServer } from "../core/runtime/node-http.js";
import { closeNodeServer } from "../runtimes/node.js";

/** A separate HTTP origin per Project; no Project process is made public. */
export function createNodeEdgePreviewHost(host: string): ZelavisEdgePreviewHost {
  return {
    async open({ port, fetch }) {
      const server = createNodeHttpServer({
        fetch: async (request) => {
          // This adapter terminates plain HTTP. Untrusted forwarded protocol
          // headers cannot turn its preview URL into an HTTPS claim.
          const url = new URL(request.url);
          url.protocol = "http:";
          return fetch(new Request(url, request));
        },
      });
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(port, host, () => { server.off("error", failed); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === "string") { await closeNodeServer(server); throw new Error("Preview has no TCP address."); }
      return { port: address.port, close: () => closeNodeServer(server, { gracePeriodMs: 1000 }) };
    },
  };
}
