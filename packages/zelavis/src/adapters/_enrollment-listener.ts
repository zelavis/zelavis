import { createServer, type Server } from "node:https";
import { Effect } from "effect";
import { IntegrationFailure, integration } from "../core/runtime/effect-boundary.js";
import { sendNodeLikeResponse } from "../core/runtime/node-http-shared.js";

/**
 * A narrow HTTPS listener whose only job is to let a machine enroll.
 *
 * It exists because a default Platform answers plain HTTP only, and a joining machine will
 * not send a credential over that. This listener serves TLS with the Platform's own pinned
 * certificate and forwards exactly one thing to the runtime: `POST` to the enrollment path.
 * Every other path is a 404 here and never reaches the runtime, so opening this port exposes
 * no dashboard, API or Project.
 *
 * Bounds: request body capped, headers and idle time capped, concurrent connections capped.
 * The route itself still enforces the token and its own attempt limit; this listener adds
 * no authority.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 64;

export interface EnrollmentListener {
  readonly port: number;
  readonly server: Server;
  readonly close: Effect.Effect<void>;
}

export const createEnrollmentListener = (options: {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Whether a request path is the enrollment route. */
  readonly isEnrollmentPath: (pathname: string) => boolean;
  readonly tls: { readonly keyPem: string; readonly certPem: string };
  readonly host: string;
  readonly port: number;
}): Effect.Effect<EnrollmentListener, IntegrationFailure> => Effect.callback((resume) => {
  const server = createServer({ key: options.tls.keyPem, cert: options.tls.certPem, minVersion: "TLSv1.2" }, (request, response) => {
    const url = new URL(request.url ?? "/", "https://enrollment.invalid");
    const refuse = (status: number, error: string) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error }));
    };
    if (!options.isEnrollmentPath(url.pathname)) return refuse(404, "Not found.");
    if (request.method !== "POST") { response.setHeader("allow", "POST"); return refuse(405, "Method not allowed."); }
    const declared = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse(413, "The request is too large.");

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; request.destroy(); return; }
      chunks.push(chunk);
    });
    request.once("error", () => { if (!response.writableEnded) response.destroy(); });
    request.once("end", () => {
      if (tooLarge) return;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.delete("content-length");
      Effect.runFork(Effect.gen(function* () {
        const answer = yield* integration(() => options.fetch(new Request(`https://${request.headers.host ?? "localhost"}${url.pathname}${url.search}`, {
          method: "POST", headers, body: Buffer.concat(chunks),
        })));
        yield* integration(() => sendNodeLikeResponse(response, answer, "POST"));
      }).pipe(Effect.catchCause(() => Effect.sync(() => {
        if (!response.headersSent) refuse(500, "Internal error."); else response.destroy();
      }))));
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 2_000;
  const failed = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
  server.once("error", failed);
  server.listen({ port: options.port, host: options.host }, () => {
    server.off("error", failed);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    resume(Effect.succeed({
      port, server,
      close: Effect.callback<void>((done) => { server.close(() => done(Effect.void)); server.closeAllConnections(); }),
    }));
  });
  return Effect.sync(() => { server.close(); server.closeAllConnections(); });
});
