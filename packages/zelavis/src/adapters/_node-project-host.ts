import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Semaphore } from "effect";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createGatewayAuthoritySecret } from "../platform/gateway-authority.js";
import { ZELAVIS_VERSION } from "../version.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import { freezeNodeProjectRelease, verifyNodeProjectRelease } from "./_node-project-release.js";
import { createNodeRuntimeGateway } from "./_node-runtime-gateway.js";
import { createNodeRuntimeJournal } from "./_node-runtime-journal.js";
import { proveNodeRuntimeUnowned } from "./_node-runtime-ownership.js";
import { createNodeRuntimeSupervisor, type NodeRuntimeExecution } from "./_node-runtime-supervisor.js";

/** The persistent App host owns the listener, journal and external replay
 * history. Engine workers own Project stores only while holding the kernel
 * ownership lock. This host has no Platform/Fabric authority of its own.
 * Installed callers resolve an exact engine from the installation catalog;
 * checkout execution supports only the current development engine.
 */
export const createNodeProjectHost = Effect.fn("ProjectHost.create")(function* (options: {
  readonly projectId: string;
  readonly directory: string;
  readonly parentSecret: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly initial?: RuntimeRelease;
  readonly integrationOnly?: boolean;
  readonly agent?: ZelavisAgentProcessRunner;
  readonly resolveEngine?: (version: string, record: Readonly<Record<string, unknown>>, configuration: Readonly<Record<string, unknown>>, environment: Readonly<Record<string, string>>) => Effect.Effect<NodeRuntimeExecution, TaggedFailure>;
  readonly startupTimeoutMs?: number;
  readonly output?: (stream: "stdout" | "stderr", line: string) => void;
}) {
  const directory = resolve(options.directory), dataDirectory = join(directory, ".zelavis", ...(options.integrationOnly ? ["integration"] : []));
  const commands = Semaphore.makeUnsafe(1);
  let parentSecret = options.parentSecret;
  let workerSecret = "";
  const secrets = new Map<string, string>();
  let commitSelection: ((selected: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>) | undefined;
  const journal = yield* createNodeRuntimeJournal(join(dataDirectory, "runtime-handover.json"));
  const initial = options.initial ?? (yield* freezeNodeProjectRelease(directory));
  // Journal recovery grants no generation until the kernel proves every
  // previous qualified engine has relinquished writable ownership.
  const recovered = yield* journal.recover(initial, proveNodeRuntimeUnowned(dataDirectory), options.initial ? "authorized-initial" : "persisted");
  const agent = options.agent ?? (yield* Effect.acquireRelease(
    Effect.sync(() => createLocalAgentProcessRunner({ stateDirectory: join(dataDirectory, "runtime-engines") })),
    agent => integration(() => agent.close()).pipe(Effect.orDie),
  ));
  const supervisor = yield* Effect.acquireRelease(createNodeRuntimeSupervisor({
    agent, workloadId: options.projectId, initial: recovered.release, generation: recovered.generation,
    startupTimeoutMs: options.startupTimeoutMs,
    headers: createNodeRuntimeGateway({ projectId: options.projectId, parentSecret: () => parentSecret, workerSecret: () => workerSecret }),
    resolve: Effect.fn("ProjectHost.resolve")(function* (selected) {
      const { snapshot, record } = yield* verifyNodeProjectRelease(directory, options.projectId, selected);
      const secret = createGatewayAuthoritySecret();
      // Every process, including rollback, gets a new private worker key.
      secrets.set(selected.digest, secret);
      const configuration = { projectId: options.projectId, dataDirectory, descriptor: join(snapshot, "project.json"), recipeDataDirectory: snapshot, integrationOnly: options.integrationOnly === true };
      const environment = { ...options.environment, ZELAVIS_PROJECT_GATEWAY_SECRET: secret, ZELAVIS_UI_DEV_SERVER: "" };
      if (options.resolveEngine) return yield* options.resolveEngine(selected.version, record, configuration, environment);
      if (selected.version !== ZELAVIS_VERSION) return yield* new IntegrationFailure(new Error("A checkout cannot execute an independently selected installed engine."));
      return { executable: process.execPath, worker: fileURLToPath(new URL("./_node-runtime-worker.js", import.meta.url)),
        module: fileURLToPath(new URL("./_node-project-engine.js", import.meta.url)), cwd: directory, configuration, environment };
    }),
    checkpoint: journal.checkpoint,
    commit: Effect.fn("ProjectHost.commit")(function* (selected, generation) {
      yield* journal.commit(selected, generation);
      if (commitSelection) yield* commitSelection(selected, generation);
      workerSecret = secrets.get(selected.digest)!;
    }),
    output: options.output,
  }), supervisor => supervisor.close.pipe(Effect.orDie));
  workerSecret = secrets.get(recovered.release.digest)!;
  return {
    listen: supervisor.listen,
    failure: supervisor.failure,
    snapshot: () => ({ release: supervisor.snapshot().release, generation: supervisor.snapshot().generation,
      requiresRecovery: supervisor.snapshot().requiresRecovery, cleanupFailures: supervisor.snapshot().cleanupFailures,
      admission: supervisor.admission.snapshot() }),
    replace: (selected: RuntimeRelease, commit?: (selected: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>) => commands.withPermit(
      Effect.acquireUseRelease(Effect.sync(() => { commitSelection = commit; }), () => supervisor.replace(selected),
        () => Effect.sync(() => { commitSelection = undefined; })),
    ),
    /** Only the authenticated Agent's existing process pipe may re-key a
     * surviving host. No secret is persisted or returned in a status event. */
    rotateParentSecret: (next: string) => commands.withPermit(evaluate(() => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(next)) throw new Error("Invalid Project Gateway signing key.");
      parentSecret = next;
    })),
  };
});
