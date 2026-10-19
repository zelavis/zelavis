import { Effect } from "effect";
import { lstat } from "node:fs/promises";
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
  let expected: string[] = [], integrations: string[] = [];
  const release = Effect.gen(function* () {
    yield* evaluate(() => options.holdPreviews?.(false));
    yield* admission.resume;
  });
  const fail = Effect.fn("AgentEngineControl.fail")(function* (message: string) {
    phase = "failed"; failure = message;
    yield* Effect.logError(`Project Agent conversion failed: ${message}`);
    // This is a coordination hold, not ownership authority. Agent process
    // identity, Project lifecycle permits and database fencing still apply.
    // Each unavailable Project reports its own failure through ordinary routing;
    // one failed recovery must not hold the healthy fleet indefinitely.
    yield* release;
  });
  const restore = Effect.fn("AgentEngineControl.restore")(function* (projectIds: readonly string[], integrationIds: readonly string[], restoringNonce: string) {
    if (!options.projects) return;
    while (true) {
      yield* effectOperations(options.projects!).reconcile();
      const current = yield* effectOperations(options.projects!).list();
      if (nonce !== restoringNonce || phase !== "restoring") return;
      if (projectIds.every(id => current.find(project => project.id === id)?.runtime.status === "running")) {
        // Public workloads are back. Private integration startup must never
        // keep those workloads behind a fleet-wide hold. Its result still
        // determines whether the installer reports a complete conversion.
        yield* release;
        const gatewayTarget = effectOperations(options.projects!).gatewayTarget;
        yield* Effect.forEach(integrationIds, id => gatewayTarget ? gatewayTarget(id).pipe(Effect.asVoid) : Effect.void, { concurrency: 1, discard: true });
        return;
      }
      yield* Effect.sleep(100);
    }
  });
  yield* serveNodeRuntimeControl(join(options.directory, "agent-update.sock"), Effect.fn("AgentEngineControl.command")(function* (input) {
    yield* evaluate(() => {
      if (input.release !== ZELAVIS_VERSION || input.generation !== options.generation ||
        typeof input.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(input.nonce)) throw new Error("Agent conversion control names another engine generation.");
    });
    if (input.action === "prepare") {
      if (phase === "held" || phase === "restoring") {
        if (nonce !== input.nonce) return yield* new IntegrationFailure(new Error("Another Agent conversion is in progress."));
        return { phase };
      }
      if (nonce === input.nonce) return yield* new IntegrationFailure(new Error("Agent conversion nonce is stale."));
      nonce = String(input.nonce); failure = undefined;
      const projects = options.projects ? yield* integration(() => options.projects!.list()) : [];
      if (projects.length > 4096) return yield* new IntegrationFailure(new Error("Agent conversion exceeds the Project bound."));
      const serving = projects.filter(project => project.desiredState === "running" && project.runtime.status === "running" && !project.deletion);
      expected = serving.map(project => project.id);
      // A regular private host journal records an integration that was already
      // used. Do not create backends for hosting-only Projects during an update.
      // This is only a restoration hint: starting it still verifies the frozen
      // recipe, host journal, ownership and current placement through the manager.
      integrations = (yield* Effect.forEach(serving.filter(project => project.recipe.managed), project =>
        integration(() => lstat(join(options.directory, "projects", project.id, ".zelavis", "integration", "runtime-handover.json"))).pipe(
          Effect.map(stats => stats.isFile() ? project.id : undefined),
          Effect.catchIf(error => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(undefined)),
        ), { concurrency: 4 })).filter((id): id is string => id !== undefined);
      yield* evaluate(() => options.holdPreviews?.(true));
      yield* admission.pause;
      yield* admission.drain(5000).pipe(Effect.mapError(error => new IntegrationFailure(error)), Effect.onError(() =>
        evaluate(() => options.holdPreviews?.(false)).pipe(Effect.andThen(admission.resume), Effect.orDie)));
      phase = "held";
      // Root may crash after preparing the hold. An old timer must not expire a
      // later conversion on the same engine.
      const preparedNonce = nonce;
      yield* Effect.forkIn(Effect.gen(function* () {
        yield* Effect.sleep(120_000);
        if (nonce === preparedNonce && (phase === "held" || phase === "restoring")) yield* fail("Agent conversion coordination expired.");
      }), scope);
    } else {
      if (input.nonce !== nonce) return yield* new IntegrationFailure(new Error("Agent conversion nonce is stale."));
      if (input.action === "restore" && phase === "held") {
        phase = "restoring";
        const restoringNonce = String(input.nonce);
        yield* Effect.forkIn(restore(expected, integrations, restoringNonce).pipe(
          Effect.timeoutOrElse({ duration: 90_000,
            orElse: () => Effect.fail(new IntegrationFailure(new Error("Projects did not recover before the Agent conversion deadline."))),
          }),
          Effect.andThen(Effect.gen(function* () {
            if (nonce === restoringNonce && phase === "restoring") { phase = "ready"; yield* release; }
          })),
          Effect.catch(error => nonce === restoringNonce && phase === "restoring" ? fail(error.message) : Effect.void),
        ), scope);
      } else if (input.action !== "status") return yield* new IntegrationFailure(new Error("Unknown or out-of-order Agent conversion command."));
    }
    return { phase, ...(failure ? { failure } : {}) };
  }));
  return admission;
});
