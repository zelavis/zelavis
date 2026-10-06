import { randomUUID } from "node:crypto";
import { Deferred, Effect, Semaphore } from "effect";
import type { ZelavisAgentProcessRunner, ZelavisAgentProcess } from "../core/agent/process-command.js";
import { createRuntimeHandover, type RuntimeRelease, type RuntimeHandoverCheckpoint } from "../core/runtime/handover.js";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createNodeRuntimeIngress } from "./_node-runtime-ingress.js";
import { NODE_RUNTIME_PROTOCOL, NODE_RUNTIME_READY_PATH } from "./_node-runtime-protocol.js";

export interface NodeRuntimeExecution {
  readonly executable: string;
  readonly worker: string;
  readonly module: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly configuration: Readonly<Record<string, unknown>>;
}
interface EngineProcess {
  readonly release: RuntimeRelease;
  readonly process: ZelavisAgentProcess;
  readonly replies: Map<string, Deferred.Deferred<{ type: string; url?: string }, TaggedFailure>>;
  url?: string;
  generation?: number;
  expectedExit?: boolean;
}

/** The same persistent ingress and writer handover hosts Platform and App engines.
 * Artifact policy, durable selection and Fabric authority belong to the caller;
 * this adapter only executes an already authorized exact release through an Agent.
 */
export const createNodeRuntimeSupervisor = Effect.fn("RuntimeSupervisor.create")(function* (options: {
  readonly workloadId: string;
  readonly agent: ZelavisAgentProcessRunner;
  readonly initial: RuntimeRelease;
  readonly generation: number;
  readonly resolve: (release: RuntimeRelease) => Effect.Effect<NodeRuntimeExecution, TaggedFailure>;
  readonly checkpoint: (value: RuntimeHandoverCheckpoint) => Effect.Effect<void, TaggedFailure>;
  readonly commit: (release: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>;
  readonly startupTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly queueLimit?: number;
  readonly headers?: Parameters<typeof createNodeRuntimeIngress>[0]["headers"];
  readonly admission?: Parameters<typeof createNodeRuntimeIngress>[0]["admission"];
  readonly output?: (stream: "stdout" | "stderr", line: string) => void;
}) {
  const timeout = options.startupTimeoutMs ?? 30_000;
  const lifecycle = Semaphore.makeUnsafe(1);
  let closed = false;
  let closing = false;
  let updating = false;
  const failed = Deferred.makeUnsafe<never, TaggedFailure>();
  let cleanupFailures: string[] = [];
  let target = "";
  const ingress = createNodeRuntimeIngress({ queueLimit: options.queueLimit, target: () => target, headers: options.headers, admission: options.admission });
  const engines = new Set<EngineProcess>();
  const prepare = Effect.fn("RuntimeSupervisor.prepare")(function* (release: RuntimeRelease) {
    const command = yield* options.resolve(release);
    const prepared = Deferred.makeUnsafe<void, TaggedFailure>();
    const replies = new Map<string, Deferred.Deferred<{ type: string; url?: string }, TaggedFailure>>();
    let state: EngineProcess | undefined;
    return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
      const child = yield* integration(() => options.agent.start({
        workloadId: `${options.workloadId}:engine:${randomUUID()}`,
        executable: command.executable, args: [command.worker], cwd: command.cwd, stdin: "pipe",
        env: { ...command.environment, ZELAVIS_RUNTIME_ENGINE_MODULE: command.module,
          ZELAVIS_RUNTIME_ENGINE_CONFIGURATION: JSON.stringify(command.configuration) },
      }, {
        onOutput: ({ stream, line }) => {
          let event: { protocol?: unknown; type?: unknown; id?: unknown; url?: unknown; error?: unknown } | undefined;
          try { event = JSON.parse(line); } catch { options.output?.(stream, line); return; }
          if (stream !== "stdout" || event?.protocol !== NODE_RUNTIME_PROTOCOL) { options.output?.(stream, line); return; }
          if (event.type === "prepared") { Deferred.doneUnsafe(prepared, Effect.void); return; }
          if (typeof event.id !== "string") return;
          const reply = replies.get(event.id);
          if (!reply) return;
          if (event.type === "failed") Deferred.doneUnsafe(reply, Effect.fail(new IntegrationFailure(new Error(String(event.error)))));
          else if (typeof event.type === "string") Deferred.doneUnsafe(reply, Effect.succeed({ type: event.type, ...(typeof event.url === "string" ? { url: event.url } : {}) }));
        },
        onExit: exit => {
          const failure = Effect.fail(new IntegrationFailure(new Error(`Engine ${release.version} exited (${exit.signal ?? exit.code}).`)));
          Deferred.doneUnsafe(prepared, failure);
          for (const reply of replies.values()) Deferred.doneUnsafe(reply, failure);
          if (state) {
            engines.delete(state);
            if (!closing && !updating && !state.expectedExit && state.url === target) {
              Effect.runSync(ingress.admission.pause);
              Deferred.doneUnsafe(failed, failure);
            }
          }
        },
      }));
      state = { release, process: child, replies }; engines.add(state);
      yield* restore(Deferred.await(prepared).pipe(Effect.timeoutOrElse({ duration: timeout,
        orElse: () => Effect.fail(new IntegrationFailure(new Error(`Engine ${release.version} preparation timed out.`))),
      }))).pipe(Effect.onError(() => integration(() => child.stop()).pipe(Effect.ignore)));
      return state;
    }));
  });
  const send = Effect.fn("RuntimeSupervisor.command")(function* (engine: EngineProcess, action: "activate" | "deactivate" | "qualify", generation?: number, reason?: "handover" | "shutdown") {
    const id = randomUUID(), reply = Deferred.makeUnsafe<{ type: string; url?: string }, TaggedFailure>();
    engine.replies.set(id, reply);
    return yield* Effect.gen(function* () {
      const written = yield* integration(() => engine.process.write?.(`${JSON.stringify({ id, action, generation, reason })}\n`));
      if (!written) return yield* new IntegrationFailure(new Error("Engine command pipe is unavailable."));
      return yield* Deferred.await(reply).pipe(Effect.timeoutOrElse({ duration: timeout,
        orElse: () => Effect.fail(new IntegrationFailure(new Error(`Engine ${action} timed out.`))),
      }));
    }).pipe(Effect.ensuring(Effect.sync(() => { engine.replies.delete(id); })));
  });
  const activate = Effect.fn("RuntimeSupervisor.activate")(function* (engine: EngineProcess, generation: number) {
    const reply = yield* send(engine, "activate", generation);
    yield* evaluate(() => {
      const url = new URL(reply.url ?? "");
      if (reply.type !== "active" || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
        throw new Error("Engine reported an invalid private runtime address.");
    });
    engine.url = reply.url;
    engine.generation = generation;
    return engine;
  });
  const probe = Effect.fn("RuntimeSupervisor.probe")(function* (owner: EngineProcess) {
    // Cover both headers and body. Cancelling a headers-only fetch timeout can
    // otherwise leave a stalled response body holding the handover indefinitely.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      controller => Effect.gen(function* () {
        const response = yield* integration(() => fetch(new URL(NODE_RUNTIME_READY_PATH, owner.url), { signal: controller.signal }), { interruptible: true });
        if (response.status !== 200) return yield* new IntegrationFailure(new Error(`Engine readiness returned HTTP ${response.status}.`));
        const status = yield* integration(() => response.json(), { interruptible: true });
        if (status.ready !== true || status.generation !== owner.generation) return yield* new IntegrationFailure(new Error("Engine readiness did not prove the active generation."));
        const qualification = yield* send(owner, "qualify");
        if (qualification.type !== "qualified") return yield* new IntegrationFailure(new Error("Engine did not prove workload continuity."));
      }).pipe(Effect.timeoutOrElse({ duration: timeout,
        orElse: () => Effect.fail(new IntegrationFailure(new Error("Engine readiness probe timed out."))),
      })),
      controller => Effect.sync(() => controller.abort()),
    );
  });
  const discard = (engine: EngineProcess) => Effect.sync(() => { engine.expectedExit = true; }).pipe(
    Effect.andThen(integration(() => engine.process.stop())), Effect.asVoid,
  );
  const initial = yield* prepare(options.initial);
  yield* Effect.gen(function* () { yield* activate(initial, options.generation); yield* probe(initial); target = initial.url!; }).pipe(Effect.onError(() => discard(initial).pipe(Effect.ignore)));
  const handover = createRuntimeHandover({ admission: ingress.admission, drainTimeoutMs: options.drainTimeoutMs ?? 30_000,
    initial: { release: options.initial, owner: initial, generation: options.generation },
    host: {
      prepare, activate, probe, discard, checkpoint: options.checkpoint,
      qualify: owner => send(owner, "qualify").pipe(Effect.flatMap(reply => reply.type === "qualified" ? Effect.void : Effect.fail(new IntegrationFailure(new Error("Engine continuity was not qualified."))))),
      deactivate: owner => send(owner, "deactivate", undefined, "handover").pipe(Effect.flatMap(reply => reply.type === "released" ? Effect.void : Effect.fail(new IntegrationFailure(new Error("Engine failed to release ownership."))))),
      restore: Effect.fn("RuntimeSupervisor.restore")(function* (release, generation) {
        // A failed or timed-out release is not proof of relinquished ownership.
        // Stop every previous owner before preparing its replacement.
        yield* Effect.forEach([...engines].filter(engine => engine.release.version === release.version && engine.release.digest === release.digest), discard, { concurrency: 1, discard: true });
        return yield* activate(yield* prepare(release), generation);
      }),
      commit: (release, owner, generation) => options.commit(release, generation).pipe(Effect.andThen(Effect.sync(() => { target = owner.url!; }))),
    },
  });
  return {
    ...ingress,
    failure: Deferred.await(failed),
    target: () => target,
    snapshot: () => ({ ...handover.snapshot(), cleanupFailures: [...cleanupFailures] }),
    replace: (release: RuntimeRelease) => lifecycle.withPermit(Effect.gen(function* () {
      if (closed) return yield* new IntegrationFailure(new Error("Runtime supervisor is closed."));
      if (closing) return yield* new IntegrationFailure(new Error("Runtime supervisor is shutting down."));
      updating = true;
      const result = yield* handover.replace(release).pipe(Effect.ensuring(Effect.sync(() => { updating = false; })));
      if (!result.owner.process.running) {
        yield* ingress.admission.pause;
        const failure = new IntegrationFailure(new Error("Selected runtime exited before handover completed."));
        yield* Deferred.fail(failed, failure);
        return yield* failure;
      }
      const retirement = yield* Effect.forEach([...engines].filter(engine => engine !== result.owner), engine => Effect.result(discard(engine)), { concurrency: 1 });
      // The prior owner already acknowledged release. Its retirement failure
      // is cleanup debt, not a failed activation of the healthy new owner.
      cleanupFailures = retirement.flatMap(result => result._tag === "Failure" ? [result.failure.message] : []);
      return { release: result.release, generation: result.generation, cleanupFailures: [...cleanupFailures] };
    })),
    close: lifecycle.withPermit(handover.stop(Effect.gen(function* () {
      if (closed) return;
      closing = true;
      yield* ingress.close;
      const owner = handover.snapshot().owner;
      if (owner.process.running) yield* send(owner, "deactivate", undefined, "shutdown");
      yield* Effect.forEach([...engines], discard, { concurrency: 4, discard: true });
      closed = true;
    }))),
  };
});
