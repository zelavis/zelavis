import { isUnknown, recordOf, parseJson } from "../core/json-validation.js";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { Deferred, Effect } from "effect";
import { createNodeHttpServer } from "../core/runtime/node-http.js";
import type { ZelavisServerRuntime } from "../core/runtime/contracts.js";
import { createRuntimeAdmission } from "../core/runtime/admission.js";
import { evaluate, integration, IntegrationFailure, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { NODE_RUNTIME_PROTOCOL, NODE_RUNTIME_READY_PATH } from "./_node-runtime-protocol.js";
import { serveNodeRuntimeCommands } from "./_node-runtime-commands.js";
import { acquireNodeRuntimeOwnership } from "./_node-runtime-ownership.js";

/** Engine modules prepare immutable code/configuration without taking live ownership. */
export interface NodeRuntimeEngine {
  open(generation: number): Effect.Effect<NodeRuntimeEngineOwner, TaggedFailure>;
}
export interface NodeRuntimeEngineOwner {
  readonly runtime: Pick<ZelavisServerRuntime, "fetch">;
  readonly qualify: Effect.Effect<void, TaggedFailure>;
  close(reason: "handover" | "abort" | "shutdown"): Effect.Effect<void, TaggedFailure>;
}
export interface NodeRuntimeEngineModule {
  prepare(configuration: Readonly<Record<string, unknown>>): Effect.Effect<NodeRuntimeEngine, TaggedFailure>;
}

const run = Effect.gen(function* () {
  const entry = yield* evaluate(() => {
    const value = process.env.ZELAVIS_RUNTIME_ENGINE_MODULE;
    if (!value) throw new Error("Runtime worker requires an immutable engine module.");
    return value;
  });
  const configuration = yield* evaluate(() => parseJson(process.env.ZELAVIS_RUNTIME_ENGINE_CONFIGURATION ?? "{}", recordOf(isUnknown)));
  const module = yield* integration(() => import(pathToFileURL(entry).href) as Promise<NodeRuntimeEngineModule>);
  if (typeof module.prepare !== "function") return yield* new IntegrationFailure(new Error("Selected engine does not implement the handover protocol."));
  const engine = yield* module.prepare(configuration);
  let active: NodeRuntimeEngineOwner | undefined;
  let server: Server | undefined;
  let releaseOwnership: Effect.Effect<void, TaggedFailure> | undefined;
  let requestOwnership = createRuntimeAdmission({ queueLimit: 1 });
  const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ protocol: NODE_RUNTIME_PROTOCOL, ...event })}\n`);
  const deactivate = Effect.fn("RuntimeWorker.deactivate")(function* (reason: "handover" | "abort" | "shutdown") {
    if (!active) {
      if (releaseOwnership) return yield* new IntegrationFailure(new Error("Partial engine activation requires process fencing before ownership can be released."));
      return;
    }
    yield* requestOwnership.pause;
    // An aborted HTTP socket does not prove its handler finished. Track the actual
    // fetch operation as well as the server's response streams before closing stores.
    yield* requestOwnership.drain(30_000);
    if (server?.listening) yield* Effect.callback<void, IntegrationFailure>(resume => {
      server!.close(error => resume(error ? Effect.fail(new IntegrationFailure(error)) : Effect.void));
      server!.closeIdleConnections();
    });
    yield* active.close(reason);
    if (releaseOwnership) yield* releaseOwnership;
    releaseOwnership = undefined;
    active = undefined; server = undefined;
  });
  const command = Effect.fn("RuntimeWorker.command")(function* (input: { id: string; action: string; generation?: number; reason?: unknown }) {
    if (input.action === "qualify") {
      if (!active) return yield* new IntegrationFailure(new Error("Engine has no active owner to qualify."));
      yield* active.qualify;
      return { type: "qualified" };
    }
    if (input.action === "deactivate") {
      if (!["handover", "abort", "shutdown"].includes(String(input.reason))) return yield* new IntegrationFailure(new Error("Engine release requires an explicit custody decision."));
      yield* deactivate(input.reason as "handover" | "abort" | "shutdown");
      return { type: "released" };
    }
    if (input.action !== "activate" || active || releaseOwnership || !Number.isSafeInteger(input.generation) || input.generation! < 1)
      return yield* new IntegrationFailure(new Error("Invalid engine activation command."));
    if (typeof configuration.dataDirectory === "string") releaseOwnership = yield* acquireNodeRuntimeOwnership(configuration.dataDirectory);
    active = yield* engine.open(input.generation!);
    requestOwnership = createRuntimeAdmission({ queueLimit: 1 });
    const owner = active;
    server = createNodeHttpServer({ fetch: (...args) => {
      if (new URL(args[0].url).pathname === NODE_RUNTIME_READY_PATH) return Promise.resolve(new Response(JSON.stringify({ ready: true, generation: input.generation }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
      return present(Effect.acquireUseRelease(
      requestOwnership.enter,
      () => integration(() => owner.runtime.fetch(...args)),
      release => Effect.sync(release),
    )); } });
    yield* Effect.callback<void, IntegrationFailure>(resume => {
      const fail = (cause: Error) => resume(Effect.fail(new IntegrationFailure(cause)));
      server!.once("error", fail);
      server!.listen(0, "127.0.0.1", () => { server!.off("error", fail); resume(Effect.void); });
    });
    const address = server.address();
    if (!address || typeof address === "string") return yield* new IntegrationFailure(new Error("Engine worker has no listening address."));
    return { type: "active", url: `http://127.0.0.1:${address.port}`, generation: input.generation };
  });
  yield* Effect.addFinalizer(() => deactivate("abort").pipe(Effect.orDie));
  const stopped = Deferred.makeUnsafe<void>();
  const stop = () => { Deferred.doneUnsafe(stopped, Effect.void); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  yield* Effect.addFinalizer(() => Effect.sync(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); }));
  const ended = yield* serveNodeRuntimeCommands({ input: process.stdin, emit,
    command: input => command(input as { id: string; action: string; generation?: number; reason?: unknown }),
  });
  emit({ type: "prepared" });
  // EOF, malformed commands and signals all close the scoped owner.
  yield* Effect.raceFirst(ended, Deferred.await(stopped));
});

Effect.runFork(Effect.scoped(run).pipe(Effect.onExit(exit => Effect.sync(() => {
  if (exit._tag === "Failure") console.error(String(exit.cause));
  process.exit(exit._tag === "Success" ? 0 : 1);
}))));
