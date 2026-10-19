import { Effect } from "effect";
import { join } from "node:path";
import { createRuntimeAdmission } from "../core/runtime/admission.js";
import { effectOperations, evaluate, integration, IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectManager } from "../project.js";
import { ZELAVIS_VERSION } from "../version.js";
import { serveNodeRuntimeControl } from "./_node-runtime-control.js";

/** Installer-local conversion control, protected by the engine's kernel writer
 * ownership and a 0600 socket. Uses the existing Project manager's authority,
 * lifecycle permits and reconciliation; it never starts a driver directly.
 * The gate also works behind an older persistent host during first conversion. */
export const serveAgentEngineControl = Effect.fn("AgentEngineControl.serve")(function* (options: {
  readonly directory: string;
  readonly generation: number;
  readonly projects?: ZelavisProjectManager;
  readonly holdPreviews?: (held: boolean) => void;
}) {
  const scope = yield* Effect.scope;
  const admission = createRuntimeAdmission({ queueLimit: 1024 });
  yield* Effect.addFinalizer(() => admission.close);
  let nonce: string | undefined, phase = "ready", failure: string | undefined;
  let expected: string[] = [];
  const restore = Effect.fn("AgentEngineControl.restore")(function* () {
    if (!options.projects) { phase = "ready"; options.holdPreviews?.(false); yield* admission.resume; return; }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      yield* effectOperations(options.projects!).reconcile();
      const current = yield* integration(() => options.projects!.list());
      if (expected.every(id => current.find(project => project.id === id)?.runtime.status === "running")) {
        // Managed apps restore their private integration lazily through this
        // ordinary manager operation. Prove those hosts ready before releasing
        // accepted Gateway requests, not only the third-party app's processes.
        const gatewayTarget = effectOperations(options.projects!).gatewayTarget;
        yield* Effect.forEach(expected, id => gatewayTarget ? gatewayTarget(id).pipe(Effect.asVoid) : Effect.void, { concurrency: 4, discard: true });
        phase = "ready";
        yield* evaluate(() => options.holdPreviews?.(false));
        yield* admission.resume;
        return;
      }
      yield* Effect.sleep(100);
    }
    return yield* new IntegrationFailure(new Error("Projects did not recover before the Agent conversion deadline."));
  });
  yield* serveNodeRuntimeControl(join(options.directory, "agent-update.sock"), Effect.fn("AgentEngineControl.command")(function* (input) {
    yield* evaluate(() => {
      if (input.release !== ZELAVIS_VERSION || input.generation !== options.generation ||
        typeof input.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(input.nonce)) throw new Error("Agent conversion control names another engine generation.");
    });
    if (input.action === "prepare") {
      if (nonce && nonce !== input.nonce && phase !== "ready") return yield* new IntegrationFailure(new Error("Another Agent conversion is in progress."));
      nonce = String(input.nonce); failure = undefined;
      const projects = options.projects ? yield* integration(() => options.projects!.list()) : [];
      if (projects.length > 4096) return yield* new IntegrationFailure(new Error("Agent conversion exceeds the Project bound."));
      expected = projects.filter(project => project.desiredState === "running" && !project.deletion).map(project => project.id);
      yield* evaluate(() => options.holdPreviews?.(true));
      yield* admission.pause;
      yield* admission.drain(5000).pipe(Effect.mapError(error => new IntegrationFailure(error)), Effect.onError(() =>
        evaluate(() => options.holdPreviews?.(false)).pipe(Effect.andThen(admission.resume), Effect.orDie)));
      phase = "held";
      // Root may crash after preparing the hold. Bound its lifetime and release
      // waiting requests with an explicit unavailable response on exhaustion.
      yield* Effect.forkIn(Effect.gen(function* () {
        yield* Effect.sleep(120_000);
        if (phase !== "ready") { phase = "failed"; failure ??= "Agent conversion coordination expired."; yield* admission.close; }
      }), scope);
    } else {
      if (input.nonce !== nonce) return yield* new IntegrationFailure(new Error("Agent conversion nonce is stale."));
      if (input.action === "restore" && phase === "held") {
        phase = "restoring";
        yield* Effect.forkIn(restore().pipe(Effect.catch(error => Effect.gen(function* () {
          phase = "failed"; failure = error.message;
          yield* admission.close;
        }))), scope);
      } else if (input.action !== "status") return yield* new IntegrationFailure(new Error("Unknown or out-of-order Agent conversion command."));
    }
    return { phase, ...(failure ? { failure } : {}) };
  }));
  return admission;
});
