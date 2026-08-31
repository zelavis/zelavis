import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { ZelavisServerRuntime } from "./contracts.js";
import { sendNodeLikeResponse, toNodeLikeWebRequest } from "./node-http-shared.js";

/**
 * Connection budgets for a directly exposed Node HTTP server.
 *
 * Node's defaults are generous for a trusted reverse-proxy deployment but leave
 * a directly reachable Platform open to slow-header and idle-connection abuse.
 * Hosts behind a proxy can raise these on the returned server.
 */
export const ZELAVIS_NODE_HTTP_TIMEOUTS = Object.freeze({
  /** Time allowed to receive the complete request headers. */
  headersTimeout: 20_000,
  /** Time allowed to receive the complete request. */
  requestTimeout: 60_000,
  /** Idle keep-alive time before the socket is closed. */
  keepAliveTimeout: 5_000,
  /** Maximum number of request headers. */
  maxHeadersCount: 200,
});

/**
 * Sends a last-resort response when request handling throws.
 *
 * If headers are already on the wire the response cannot be rewritten, so the
 * socket is destroyed instead — the alternative is a client that waits forever.
 */
function failClosed(response: ServerResponse, status: number): void {
  try {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ error: status === 400 ? "Bad request" : "Internal error" }),
    );
  } catch {
    // The socket is already gone; nothing further to do.
    try {
      response.destroy();
    } catch {
      // ignore
    }
  }
}

export function createNodeHttpServer<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "fetch">,
): Server {
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      // Let handlers observe the client going away instead of finishing work
      // for a socket that is already closed.
      //
      // The signal is driven from the *response*, not the request:
      // `IncomingMessage` emits `close` as soon as its stream is fully read and
      // destroyed, which for any request carrying a body happens the moment the
      // dispatcher parses it — long before the handler is done. Aborting there
      // cancelled every POST/PUT/PATCH handler that awaited outbound work.
      // `ServerResponse` emits `close` when the response finishes or the
      // connection drops, so a premature close is the real disconnect signal.
      const controller = new AbortController();
      const abort = () => controller.abort();
      const abortIfUnfinished = () => {
        if (!response.writableFinished) abort();
      };
      request.once("aborted", abort);
      response.once("close", abortIfUnfinished);

      let webRequest: Request;
      try {
        webRequest = await toNodeLikeWebRequest(request, {
          signal: controller.signal,
        });
      } catch {
        // Malformed request line, path, or headers: the request could not even
        // be represented, so this is a client error.
        failClosed(response, 400);
        return;
      }

      try {
        const webResponse = await runtime.fetch(webRequest, {
          platform: { node: { request, response } },
        });
        await sendNodeLikeResponse(response, webResponse, request.method ?? "GET");
      } catch {
        // Lifecycle hooks, principal resolution, and response streaming can all
        // throw outside the dispatcher's own error mapping. Without this the
        // client receives nothing and the process takes an unhandled rejection.
        failClosed(response, 500);
      } finally {
        request.off("aborted", abort);
        response.off("close", abortIfUnfinished);
      }
    },
  );

  server.headersTimeout = ZELAVIS_NODE_HTTP_TIMEOUTS.headersTimeout;
  server.requestTimeout = ZELAVIS_NODE_HTTP_TIMEOUTS.requestTimeout;
  server.keepAliveTimeout = ZELAVIS_NODE_HTTP_TIMEOUTS.keepAliveTimeout;
  server.maxHeadersCount = ZELAVIS_NODE_HTTP_TIMEOUTS.maxHeadersCount;

  return server;
}
