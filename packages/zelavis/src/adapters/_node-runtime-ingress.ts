import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { Effect, Fiber } from "effect";
import { createRuntimeAdmission } from "../core/runtime/admission.js";
import type { RuntimeAdmission } from "../core/runtime/admission.js";
import { IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { ZELAVIS_NODE_HTTP_TIMEOUTS } from "../core/runtime/node-http.js";
import { NODE_RUNTIME_READY_PATH } from "./_node-runtime-protocol.js";

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function endToEndHeaders(input: IncomingHttpHeaders): IncomingHttpHeaders {
  const connection = String(input.connection ?? "").toLowerCase().split(",").map(value => value.trim());
  return Object.fromEntries(Object.entries(input).filter(([name]) => !HOP_HEADERS.has(name) && !connection.includes(name)));
}
function privateReadiness(path: string | undefined): boolean {
  try { return new URL(path ?? "/", "http://ingress.invalid").pathname === NODE_RUNTIME_READY_PATH; }
  catch { return false; }
}

/** Stable, streaming HTTP ingress. Queued bodies retain Node stream backpressure;
 * response completion, aborted uploads and upgraded sockets all own drain permits.
 * The target is a trusted private engine address, never a caller-controlled URL.
 */
export function createNodeRuntimeIngress(options: {
  readonly queueLimit?: number;
  /** Platform preview listeners share the engine's one drain boundary. */
  readonly admission?: RuntimeAdmission;
  readonly target: () => string;
  /** Authenticate before queuing, then mint private headers for the selected
   * engine after admission. A nonce is consumed once by the stable supervisor. */
  readonly headers?: (headers: IncomingHttpHeaders) => Effect.Effect<() => Effect.Effect<IncomingHttpHeaders, TaggedFailure>, TaggedFailure>;
}) {
  const admission = options.admission ?? createRuntimeAdmission({ queueLimit: options.queueLimit ?? 1024 });
  const sockets = new Set<Socket>();
  const pending = new Set<Fiber.Fiber<any, any>>();
  function acquire(socket: Socket, headers: IncomingHttpHeaders, handle: (release: () => void, headers: IncomingHttpHeaders) => void, reject: () => void) {
    let release: (() => void) | undefined;
    let transferred = false;
    const operation = Effect.gen(function* () {
      const selectedHeaders = options.headers ? yield* options.headers(headers) : () => Effect.succeed(headers);
      release = yield* admission.enter;
      const forwarded = yield* selectedHeaders();
      if (socket.destroyed) return;
      yield* Effect.try({ try: () => { handle(release!, forwarded); transferred = true; }, catch: cause => new IntegrationFailure(cause) });
    }).pipe(Effect.ensuring(Effect.sync(() => { if (!transferred) release?.(); })), Effect.catch(() => Effect.sync(reject)));
    const fiber = Effect.runFork(operation);
    pending.add(fiber);
    const gone = () => { Effect.runFork(Fiber.interrupt(fiber)); };
    socket.once("close", gone);
    fiber.addObserver(() => { pending.delete(fiber); socket.off("close", gone); });
  }
  function forward(incoming: IncomingMessage, outgoing: ServerResponse, release: () => void, headers: IncomingHttpHeaders) {
    const target = new URL(options.target());
    if (target.protocol !== "http:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Ingress requires a private HTTP engine origin.");
    let finished = false;
    const done = () => { if (!finished) { finished = true; release(); } };
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: incoming.method,
      // Keep the original origin, request path and credentials. Gateway authorization
      // remains entirely inside the selected engine's dispatcher.
      path: incoming.url, headers: endToEndHeaders(headers),
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
      response.once("error", error => { outgoing.destroy(error); });
      response.once("aborted", () => { outgoing.destroy(); });
      response.pipe(outgoing);
    });
    upstream.once("error", () => {
      if (!outgoing.headersSent) { outgoing.writeHead(502); outgoing.end("Runtime unavailable."); }
      else outgoing.destroy();
    });
    // Keep the ingress permit until response completion or upstream closure.
    // The worker also tracks handler completion: socket closure alone never
    // proves that a database operation inside the engine has finished.
    upstream.once("close", done);
    outgoing.once("finish", done);
    outgoing.once("close", () => { upstream.destroy(); });
    incoming.once("aborted", () => { upstream.destroy(); });
    // Body timeout starts only after admission. Node's whole-server request
    // timeout would otherwise expire uploads deliberately paused by a handover.
    if (!incoming.complete) {
      const bodyTimeout = setTimeout(() => {
        if (!outgoing.headersSent) { outgoing.writeHead(408); outgoing.end(); }
        upstream.destroy(); incoming.destroy();
      }, ZELAVIS_NODE_HTTP_TIMEOUTS.requestTimeout);
      bodyTimeout.unref();
      const clear = () => clearTimeout(bodyTimeout);
      incoming.once("end", clear); incoming.once("aborted", clear); outgoing.once("close", clear);
    }
    incoming.pipe(upstream);
  }
  const server = createServer((incoming, outgoing) => {
    if (privateReadiness(incoming.url)) { outgoing.writeHead(404); outgoing.end(); return; }
    incoming.pause();
    acquire(incoming.socket, incoming.headers, (release, headers) => forward(incoming, outgoing, release, headers), () => {
      if (!outgoing.destroyed) { outgoing.writeHead(503, { "retry-after": "1" }); outgoing.end("Runtime admission unavailable."); }
    });
  });
  Object.assign(server, ZELAVIS_NODE_HTTP_TIMEOUTS);
  server.requestTimeout = 0;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (incoming, client, head) => {
    if (privateReadiness(incoming.url)) { client.destroy(); return; }
    client.pause();
    acquire(client as Socket, incoming.headers, (release, headers) => {
      const target = new URL(options.target());
      if (target.protocol !== "http:" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) throw new Error("Ingress requires a private HTTP engine origin.");
      const upstream = connect(Number(target.port || 80), target.hostname);
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      // Upgrade tunnels drain only when both ends close. An update timeout
      // resumes the old engine instead of forcibly disconnecting the tunnel.
      upstream.once("close", done);
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("connect", () => {
        upstream.write(`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n`);
        if (!options.headers) {
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) upstream.write(`${incoming.rawHeaders[i]}: ${incoming.rawHeaders[i + 1]}\r\n`);
        } else {
          for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) upstream.write(`${name}: ${item}\r\n`);
        }
        upstream.write("\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    }, () => client.destroy());
  });
  const listen = (address: { readonly host: string; readonly port: number } | { readonly fd: number }) =>
    Effect.callback<number, IntegrationFailure>((resume, signal) => {
      const failed = (cause: Error) => resume(Effect.fail(new IntegrationFailure(cause)));
      server.once("error", failed);
      server.listen({ ...address, signal }, () => {
        server.off("error", failed);
        const bound = server.address();
        if (!bound || typeof bound === "string") { failed(new Error("Ingress has no TCP address.")); return; }
        resume(Effect.succeed(bound.port));
      });
      return Effect.sync(() => { server.off("error", failed); });
    });
  const close = Effect.gen(function* () {
    if (!options.admission) yield* admission.close;
    yield* Effect.forEach([...pending], Fiber.interrupt, { concurrency: 16, discard: true });
    for (const socket of sockets) socket.destroy();
    if (!server.listening) return;
    yield* Effect.callback<void, IntegrationFailure>(resume => {
      server.close(error => resume(error ? Effect.fail(new IntegrationFailure(error)) : Effect.void));
    });
  });
  return { server, admission, listen, close };
}
