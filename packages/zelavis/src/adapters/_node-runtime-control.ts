import { StringDecoder } from "node:string_decoder";
import { request, createServer, type Server } from "node:http";
import { chmod, lstat, rm } from "node:fs/promises";
import { Effect, Fiber } from "effect";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";

const LIMIT = 64 * 1024;
/** A bounded local control channel, accessible only to the installation UID
 * and root. It never accepts executables, arbitrary modules or shell commands. */
export const requestNodeRuntimeControl = Effect.fn("RuntimeControl.request")(function* (socketPath: string, input: Readonly<Record<string, unknown>>, token?: string) {
  const body = yield* evaluate(() => {
    const source = JSON.stringify(input);
    if (Buffer.byteLength(source) > LIMIT) throw new Error("Runtime control request exceeds its size bound.");
    return source;
  });
  return yield* Effect.callback<Readonly<Record<string, unknown>>, IntegrationFailure>((resume, signal) => {
    const call = request({ socketPath, path: "/", method: "POST", signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }, response => {
      let source = "", size = 0;
      const decoder = new StringDecoder("utf8");
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIMIT) { call.destroy(new Error("Runtime control response exceeds its size bound.")); return; }
        source += decoder.write(chunk);
      });
      response.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
      response.once("end", () => resume(evaluate(() => {
        const value = JSON.parse(source + decoder.end());
        if (response.statusCode !== 200 || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(typeof value?.error === "string" ? value.error : "Runtime control request was refused.");
        return value as Readonly<Record<string, unknown>>;
      })));
    });
    call.once("error", cause => resume(Effect.fail(new IntegrationFailure(cause))));
    call.setTimeout(150_000, () => call.destroy(new Error("Runtime control request timed out.")));
    call.end(body);
    return Effect.sync(() => call.destroy());
  });
});

export const serveNodeRuntimeControl = Effect.fn("RuntimeControl.serve")(function* (socketPath: string,
  command: (input: Readonly<Record<string, unknown>>, token: string | undefined) => Effect.Effect<Readonly<Record<string, unknown>>, TaggedFailure>) {
  // The caller holds its kernel journal lock. Refuse regular files and links;
  // only an abandoned socket from this exact host may be removed.
  const existing = yield* integration(() => lstat(socketPath)).pipe(Effect.catchIf(error => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.void));
  if (existing) {
    yield* evaluate(() => { if (!existing.isSocket() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) throw new Error("Runtime control path is not an owned socket."); });
    yield* integration(() => rm(socketPath));
  }
  const pending = new Set<Fiber.Fiber<void, never>>();
  const fork = Effect.runForkWith(yield* Effect.context<never>());
  let closing = false;
  const server: Server = createServer((incoming, outgoing) => {
    if (closing || pending.size >= 32 || incoming.method !== "POST" || incoming.url !== "/") { outgoing.writeHead(503); outgoing.end(); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    const received = Effect.callback<Record<string, unknown>, IntegrationFailure>((resume, signal) => {
      const fail = (cause: Error) => resume(Effect.fail(new IntegrationFailure(cause)));
      incoming.on("data", chunk => {
        size += chunk.length;
        if (size > LIMIT) { fail(new Error("Runtime control request exceeds its size bound.")); incoming.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      });
      incoming.once("error", fail);
      incoming.once("end", () => resume(evaluate(() => {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime control request.");
        return value;
      })));
      incoming.setTimeout(30_000, () => fail(new Error("Runtime control upload timed out.")));
      const aborted = () => incoming.destroy();
      signal.addEventListener("abort", aborted, { once: true });
      return Effect.sync(() => { incoming.off("error", fail); signal.removeEventListener("abort", aborted); });
    });
    const operation = received.pipe(Effect.flatMap(input => command(input, incoming.headers.authorization)), Effect.match({
      onSuccess: value => { outgoing.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); outgoing.end(JSON.stringify(value)); },
      onFailure: error => { outgoing.writeHead(400, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ error: error.message })); },
    }));
    const fiber = fork(operation); pending.add(fiber);
    fiber.addObserver(() => pending.delete(fiber));
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.maxHeadersCount = 32;
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    closing = true;
    yield* Effect.forEach([...pending], Fiber.interrupt, { concurrency: 4, discard: true });
    server.closeAllConnections();
    if (server.listening) yield* Effect.callback<void, IntegrationFailure>(resume => { server.close(cause => resume(cause ? Effect.fail(new IntegrationFailure(cause)) : Effect.void)); }).pipe(Effect.orDie);
    yield* integration(() => rm(socketPath, { force: true })).pipe(Effect.orDie);
  }));
  yield* Effect.callback<void, IntegrationFailure>((resume, signal) => {
    const fail = (cause: Error) => resume(Effect.fail(new IntegrationFailure(cause)));
    server.once("error", fail);
    server.listen({ path: socketPath, signal }, () => { server.off("error", fail); resume(Effect.void); });
    return Effect.sync(() => server.off("error", fail));
  });
  yield* integration(() => chmod(socketPath, 0o600));
});

export const NODE_RUNTIME_PREVIEW_ID = "x-zelavis-runtime-preview";
export const NODE_RUNTIME_PREVIEW_KEY = "x-zelavis-runtime-preview-key";
