import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isString, objectFields, parseJson } from "../core/json-validation.js";
import { runtimeReleaseRecord } from "../core/runtime/handover.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";
import { evaluate, integration, IntegrationFailure, present } from "../core/runtime/effect-boundary.js";
import { shutdownOnSignals } from "../runtimes/node.js";
import { createNodeProjectHost } from "./_node-project-host.js";
import { serveNodeProjectControl } from "./_node-project-control.js";
import { projectProcessEnvironment } from "./_project-process-environment.js";
import { inheritedAppShardEnvironment } from "./_app-shard-environment.js";
import { inheritedProjectLeaseEnvironment } from "./_project-lease-environment.js";
import { raiseProjectOomScore } from "./_project-oom-score.js";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import type { NodeRuntimeExecution } from "./_node-runtime-supervisor.js";

const exec = promisify(execFile);
const verifier = fileURLToPath(new URL("./_node-project-engine-verifier.js", import.meta.url));
const executionPaths = objectFields<Pick<NodeRuntimeExecution, "executable" | "worker" | "module" | "cwd">>({
  executable: isString, worker: isString, module: isString, cwd: isString,
});
const VERIFIER_TIMEOUT_MS = 300_000;

// The Agent runs a persistent host; Platform and App workers use the same
// admission/ownership protocol. The App's host never gains parent authority.
const scope = Scope.makeUnsafe();
const run = Scope.use(Effect.gen(function* () {
  const options = yield* evaluate(() => {
    const projectId = process.env.ZELAVIS_PROJECT_ID?.trim();
    const dataDirectory = process.env.ZELAVIS_PROJECT_DATA_DIR?.trim();
    const parentSecret = process.env.ZELAVIS_PROJECT_GATEWAY_SECRET?.trim();
    const port = Number(process.env.PORT ?? 0);
    if (!projectId || !dataDirectory) throw new Error("Project runner requires a project id and data directory.");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Project runner received an invalid port.");
    if (!parentSecret || !/^[A-Za-z0-9_-]{43}$/.test(parentSecret)) throw new Error("Project host requires an ephemeral Gateway signing key.");
    const initial = process.env.ZELAVIS_PROJECT_INITIAL_RELEASE ? parseJson(process.env.ZELAVIS_PROJECT_INITIAL_RELEASE, runtimeReleaseRecord) : undefined;
    return { projectId, directory: resolve(dataDirectory, ".."), parentSecret, port, initial, integrationOnly: process.argv.includes("--integration") };
  });
  // Before the engine starts, so it and everything the Project runs inherit the ranking.
  yield* raiseProjectOomScore();
  let shutdown: ReturnType<typeof shutdownOnSignals> | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => shutdown?.dispose()));
  shutdown = shutdownOnSignals(() => present(Scope.close(scope, Exit.void)));
  const catalogDirectory = process.env.ZELAVIS_RUNTIME_RELEASES_DIR;
  const catalogOptions = catalogDirectory ? { directory: catalogDirectory, rootOwned: process.env.ZELAVIS_RUNTIME_ROOT_OWNED === "true" } : undefined;
  const host = yield* createNodeProjectHost({ ...options, environment: { ...projectProcessEnvironment(), ...inheritedProjectLeaseEnvironment(), ...inheritedAppShardEnvironment() },
    ...(catalogOptions ? { resolveEngine: Effect.fn("ProjectHost.installedEngine")(function* (version, record, configuration, environment) {
      const digest = yield* evaluate(() => {
        if (options.integrationOnly) return undefined;
        const engine = record.engine as { runtime?: RuntimeRelease } | undefined;
        if (engine?.runtime?.version !== version || !/^sha256:[a-f0-9]{64}$/.test(engine.runtime.digest))
          throw new Error("Installed Project requires its exact runtime engine lock.");
        return engine.runtime.digest;
      });
      // The inventory walk and hashing allocate substantially more than the resident host needs.
      // Wait for the verifier to exit before launching the engine so its allocations are released.
      const { stdout } = yield* integration(signal => exec(process.execPath,
        [verifier, catalogOptions.directory, String(catalogOptions.rootOwned), version, ...(digest ? [digest] : [])],
        { signal, env: projectProcessEnvironment(), timeout: VERIFIER_TIMEOUT_MS, maxBuffer: 64 * 1024 }), { interruptible: true });
      const paths = yield* evaluate(() => parseJson(stdout, executionPaths));
      return { ...paths, configuration, environment };
    }) } : {}),
    output: (stream, line) => { (stream === "stderr" ? process.stderr : process.stdout).write(`${line}\n`); },
  });
  const port = yield* host.listen({ port: options.port, host: "127.0.0.1" });
  const emit = (value: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  const commits = new Map<string, { id: unknown; reply: Deferred.Deferred<void, IntegrationFailure> }>();
  yield* serveNodeProjectControl({ directory: options.directory, integrationOnly: options.integrationOnly, emit,
    acknowledge: input => {
      if (input.action !== "commit-ack") return false;
      const waiting = typeof input.nonce === "string" ? commits.get(input.nonce) : undefined;
      if (waiting && waiting.id === input.id) Deferred.doneUnsafe(waiting.reply, input.ok === true ? Effect.void
        : Effect.fail(new IntegrationFailure(new Error(String(input.error ?? "Project lock commit failed.")))));
      return true;
    },
    command: Effect.fn("ProjectHost.command")(function* (input) {
      if (input.action === "status") return { type: "status", ...host.snapshot() };
      if (input.action === "rotate-key") {
        yield* host.rotateParentSecret(String(input.secret ?? ""));
        return { type: "key-rotated", url: `http://127.0.0.1:${port}` };
      }
      if (input.action === "replace") {
        const selected = yield* evaluate(() => {
          const value = input.release as RuntimeRelease;
          if (!value || typeof value.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) throw new Error("Replace requires an immutable Project release.");
          return value;
        });
        return { type: "replaced", ...yield* host.replace(selected, input.commit === true ? Effect.fn("ProjectHost.requestCommit")(function* (release, generation) {
          const nonce = randomUUID(), reply = Deferred.makeUnsafe<void, IntegrationFailure>();
          commits.set(nonce, { id: input.id, reply });
          return yield* Effect.gen(function* () {
            emit({ protocol: NODE_RUNTIME_PROTOCOL, type: "commit", id: input.id, nonce, release, generation });
            yield* Deferred.await(reply).pipe(Effect.timeoutOrElse({ duration: 15_000,
              orElse: () => Effect.fail(new IntegrationFailure(new Error("Platform did not commit the Project lock before its deadline."))),
            }));
          }).pipe(Effect.ensuring(Effect.sync(() => { commits.delete(nonce); })));
        }) : undefined) };
      }
      return yield* new IntegrationFailure(new Error("Unknown Project host command."));
    }),
  });
  emit({ type: "ready", projectId: options.projectId, url: `http://127.0.0.1:${port}` });
  // Agent transport loss has no bearing on this host's serving lifetime.
  return yield* host.failure;
}), scope);

Effect.runFork(run.pipe(Effect.catchCause(cause => Effect.sync(() => { console.error(String(cause)); process.exit(1); }))));
