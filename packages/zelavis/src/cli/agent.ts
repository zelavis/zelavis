import { Cause, Effect, Fiber, type Scope } from "effect";
import { evaluate, integration, present, integrationValue, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
/**
 * `zelavis agent` — run the Agent as its own process.
 *
 * Deliberately a separate command rather than something `zelavis serve` starts.
 * An Agent the Platform spawns shares the Platform's fate, which is the exact
 * property this is meant to break: the operator supervises it — systemd,
 * launchd, whatever the host uses — so a Platform restart is not a restart of
 * everything the Platform was running.
 *
 * Ordinary shutdown stops owned processes. A valid generation-bound handover
 * marker lets Linux survivable mode release supervision to its replacement;
 * durable records and placement leases remain authoritative across that gap.
 */
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveCliDataDirectory } from "./data-directory.js";
import { createAgentProcessServer } from "../adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../adapters/_agent-process-runner.js";
import { createLocalSqliteSystemStore } from "../adapters/_sqlite-system-store.js";
import { REMOTE_ENVIRONMENT_WORKLOAD_PREFIX } from "../adapters/_agent-remote-environment.js";
import { readLocalProjectPlacementLease } from "../platform/project-placement-authority.js";
import { createRemoteProjectAgent } from "../adapters/_remote-project-agent.js";
import { TRUST_REFRESH_INTERVAL_MS, refreshTrustFile } from "../adapters/_trust-refresh.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import {
  createAgentHostOperationService,
  type AgentHostOperationService,
} from "../adapters/_agent-host-operations.js";
import { prepareDelegatedCgroupLayout } from "../adapters/_linux-cgroup-supervisor.js";
import { consumeAgentHandover, publishAgentDescriptor } from "../adapters/_agent-lifecycle.js";

export interface RunAgentCommandOptions {
  /** Defaults to the same `.zelavis` directory the Platform uses. */
  readonly dataDirectory?: string;
  /** Injected by tests; production waits for a signal. */
  readonly signal?: AbortSignal;
  /**
   * Installed host operations. Without it the Agent runs Project
   * processes only and refuses operation requests.
   */
  readonly operationsRoot?: string;
  /** Dedicated host operation Agent; never starts or reclaims Project processes. */
  readonly operationsOnly?: boolean;
  readonly endpointGroupAccess?: boolean;
  /** Platform authority public keys; required with `operationsRoot`. */
  readonly platformAuthority?: string;
  /** Require a root-owned operation tree, manifests and interpreters. */
  readonly requireRootOwnedOperations?: boolean;
  /**
   * cgroup v2 containment for operations: `delegated` lays out the cgroup
   * systemd delegated to this process, a path names an operations root. Absent
   * means process-group supervision. Never falls back when set.
   */
  readonly operationCgroup?: string;
  readonly operationMemoryMaxBytes?: number;
  readonly operationPidsMax?: number;
  /** Local System Store file shared with the Platform for Project self-fencing. */
  readonly placementStore?: string;
  /** JSON config for this Agent's pinned-TLS remote Project listener. */
  readonly remoteProjectConfig?: string;
}

/** Called with the Agent once it listens; tests use it to reach the service. */
export type RunAgentCommandReady = (agent: {
  readonly socketPath: string;
  readonly operations?: AgentHostOperationService;
}) => void;

export function runAgentCommand(
  options: RunAgentCommandOptions & { readonly onReady?: RunAgentCommandReady } = {},
): Promise<void> {
  return present(Effect.scoped(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure, Scope.Scope> {
  const dataDirectory = resolveCliDataDirectory(options.dataDirectory);
  if (options.operationsOnly && (!options.operationsRoot || !options.platformAuthority)) {
    throw new Error("--operations-only requires --operations-root and --platform-authority.");
  }
  if (options.operationsOnly && (options.remoteProjectConfig || options.placementStore)) {
    throw new Error("--operations-only cannot be combined with Project Agent options.");
  }
  if (options.endpointGroupAccess) {
    if (!options.operationsOnly || !options.requireRootOwnedOperations || process.getuid?.() !== 0) {
      throw new Error("--endpoint-group-access requires a root --operations-only Agent with --require-root-owned-operations.");
    }
    yield* integrationValue(mkdir(dataDirectory, { recursive: true, mode: 0o750 }));
    for (let path = dataDirectory; ; path = dirname(path)) {
      const stats = yield* integrationValue(lstat(path));
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== 0 || (stats.mode & 0o022) !== 0) {
        throw new Error("Privileged Agent state and its ancestors must be root-owned and not group/world-writable.");
      }
      if (path === dirname(path)) break;
    }
  }
  if (options.remoteProjectConfig) {
    if (options.operationsRoot || options.platformAuthority ||
        options.placementStore) {
      throw new Error("Remote Project Agent config cannot be combined with local Agent options.");
    }
    const file = resolve(options.remoteProjectConfig);
    const config = (yield* integrationValue(readFile(file, "utf8")).pipe(
      Effect.flatMap((text) => evaluate(() => JSON.parse(text))),
    )) as {
      host?: unknown; port?: unknown; keyFile?: unknown; certFile?: unknown;
      trustFile?: unknown; agentId?: unknown; nodeId?: unknown;
      platform?: { url?: unknown; fingerprint?: unknown; caFile?: unknown };
    };
    if (typeof config.host !== "string" || typeof config.port !== "number" ||
        typeof config.keyFile !== "string" || typeof config.certFile !== "string" ||
        typeof config.trustFile !== "string" || typeof config.agentId !== "string" ||
        typeof config.nodeId !== "string") {
      throw new Error("Remote Project Agent config needs host, port, keyFile, certFile, trustFile, agentId and nodeId.");
    }
    const relativeFile = (path: string) => resolve(dirname(file), path);
    const [keyPem, certPem, trustText] = yield* Effect.all([
      integration(() => readFile(relativeFile(config.keyFile as string), "utf8")),
      integration(() => readFile(relativeFile(config.certFile as string), "utf8")),
      integration(() => readFile(relativeFile(config.trustFile as string), "utf8")),
    ], { concurrency: 3 });
    const trust = (yield* evaluate(() => JSON.parse(trustText))) as ZelavisHostOperationTrustStore;
    if (!Array.isArray(trust.keys) || trust.keys.length === 0) {
      throw new Error("Remote Project Agent trust file has no Platform keys.");
    }
    // The keys in force. A rotation on the Platform replaces them here without a restart.
    let currentTrust = trust;
    const platformUrl = config.platform?.url;
    const refresher = typeof platformUrl === "string"
      ? Effect.runFork(Effect.forever(
          refreshTrustFile({
            platform: {
              url: platformUrl,
              ...(typeof config.platform?.fingerprint === "string" ? { fingerprint: config.platform.fingerprint } : {}),
              ...(typeof config.platform?.caFile === "string" ? { caFile: relativeFile(config.platform.caFile) } : {}),
            },
            trustFile: relativeFile(config.trustFile as string),
          }).pipe(
            Effect.tap((refreshed) => Effect.sync(() => {
              currentTrust = refreshed.trust;
              if (refreshed.changed) console.log("Updated the Platform's keys.");
            })),
            // A Platform that cannot be reached right now must not stop the Agent serving: it keeps the keys it has.
            Effect.catch((failure) => Effect.logWarning(failure.message)),
            Effect.andThen(Effect.sleep(TRUST_REFRESH_INTERVAL_MS)),
          )))
      : undefined;
    const stopRefreshing = refresher ? Fiber.interrupt(refresher) : Effect.void;
    const remote = yield* integrationValue(createRemoteProjectAgent({
      dataDirectory, host: config.host, port: config.port,
      keyPem, certPem, trust: () => currentTrust, agentId: config.agentId, nodeId: config.nodeId,
    }));
    console.log(`Zelavis Project Agent listening on ${remote.address}`);
    const signal = options.signal;
    if (signal) {
      if (!signal.aborted) yield* untilAborted(signal);
      yield* integrationValue(remote.close());
      yield* stopRefreshing;
      return;
    }
    yield* Effect.callback<void>((resume) => {
      const stop = () => { void remote.close().finally(() => resume(stopRefreshing)); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const endpointDirectory = join(dataDirectory, "agent");

  const runner: ZelavisAgentProcessRunner = yield* Effect.acquireRelease(evaluate((): ZelavisAgentProcessRunner => options.operationsOnly ? {
    name: "host-operations-only",
    start: () => present(Effect.gen(function* () { throw new Error("This Agent executes installed host operations only."); })),
    close: () => present(Effect.gen(function* () {})),
  } : createLocalAgentProcessRunner({
    // The same records the in-process runner keeps, in the same place, so an
    // installation that switches between the two does not lose track of what
    // the other started.
    stateDirectory: join(dataDirectory, "projects", ".agent-processes"),
    survivable: process.platform === "linux" && !options.operationsRoot,
  })), runner => integration(() => runner.detach ? runner.detach() : runner.close()).pipe(Effect.orDie));

  // Survivable mode validates and adopts under its kernel lock. Ordinary
  // pipe runners still reclaim a dead owner's abandoned processes.
  const reclaimed = (yield* integration(() => runner.reclaim?.())) ?? 0;
  if (reclaimed > 0) {
    console.log(`Reclaimed ${reclaimed} process(es) left by an earlier run.`);
  }

  let operations: AgentHostOperationService | undefined;
  if (options.operationsRoot) {
    if (!options.platformAuthority) {
      throw new Error("--operations-root requires --platform-authority.");
    }
    const limits = {
      ...(options.operationMemoryMaxBytes !== undefined
        ? { memoryMaxBytes: options.operationMemoryMaxBytes }
        : {}),
      ...(options.operationPidsMax !== undefined ? { pidsMax: options.operationPidsMax } : {}),
    };
    const cgroupRoot = options.operationCgroup === "delegated"
      ? (yield* integrationValue(prepareDelegatedCgroupLayout({
          controllers: [
            ...(limits.memoryMaxBytes !== undefined ? ["memory" as const] : []),
            ...(limits.pidsMax !== undefined ? ["pids" as const] : []),
          ],
        }))).operations
      : options.operationCgroup;
    operations = yield* integrationValue(createAgentHostOperationService({
      directory: join(dataDirectory, "agent-operations"),
      operationsRoot: resolve(options.operationsRoot),
      platformAuthorityFile: resolve(options.platformAuthority),
      requireRootOwned: options.requireRootOwnedOperations === true,
      ...(options.operationsOnly && process.env.ZELAVIS_HOST_PACKAGES_DIR
        ? { environment: { ZELAVIS_HOST_PACKAGES_DIR: process.env.ZELAVIS_HOST_PACKAGES_DIR } } : {}),
      ...(cgroupRoot
        ? { supervision: { kind: "cgroup-v2" as const, root: cgroupRoot, limits } }
        : {}),
    }));
    const platformAuthorityPresent = yield* integration(() => access(resolve(options.platformAuthority!))).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!platformAuthorityPresent) {
      console.log(
        `Platform authority file ${options.platformAuthority} does not exist yet; every operation request is refused until the Platform creates it.`,
      );
    }
    console.log(
      `Host operations: ${operations.registered.length} installed (${cgroupRoot ? `cgroup ${cgroupRoot}` : "process-group supervision"}).`,
    );
  } else if (options.operationCgroup || options.platformAuthority) {
    throw new Error("Host operation options require --operations-root.");
  }

  const placementStore = options.operationsOnly ? undefined : yield* Effect.acquireRelease(evaluate(() => createLocalSqliteSystemStore({
    filename: resolve(options.placementStore ?? join(dataDirectory, "system", "zelavis.sqlite")),
  })), store => integration(() => store.close?.()).pipe(Effect.orDie));
  const server = yield* Effect.acquireRelease(integrationValue(createAgentProcessServer({
    directory: endpointDirectory,
    runner,
    operationsOnly: options.operationsOnly,
    endpointGroupAccess: options.endpointGroupAccess,
    ...(operations ? { operations } : {}),
    ...(placementStore ? { placement: {
      isProjectWorkload: (id: string) => !id.startsWith(REMOTE_ENVIRONMENT_WORKLOAD_PREFIX),
      read: (projectId: string) => readLocalProjectPlacementLease(placementStore, projectId),
    } } : {}),
  })), server => integration(() => server.close({ preserveProcesses: runner.detach !== undefined })).pipe(Effect.orDie));

  console.log(`Zelavis Agent listening on ${server.socketPath}`);
  const descriptor = yield* publishAgentDescriptor(endpointDirectory, runner.recover !== undefined);

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= present(consumeAgentHandover(endpointDirectory, descriptor).pipe(
      Effect.flatMap(preserveProcesses => integration(() => server.close({ preserveProcesses }))),
      Effect.catchCause((cause) => Effect.sync(() => {
        const error = unwrapFailure(Cause.squash(cause));
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })),
    ));
    return closing;
  };

  const signalled = () => { void shutdown(); };
  process.once("SIGINT", signalled);
  process.once("SIGTERM", signalled);
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    process.off("SIGINT", signalled); process.off("SIGTERM", signalled);
  }));
  options.onReady?.({ socketPath: server.socketPath, ...(operations ? { operations } : {}) });

  const stopSignal = options.signal;
  if (stopSignal) {
    if (!stopSignal.aborted) yield* untilAborted(stopSignal);
    yield* integrationValue(shutdown());
    return;
  }

  while (!closing) yield* Effect.sleep(100);
  yield* integrationValue(closing);
  })));
}

/** Completes when the signal aborts; a listener left behind by an interrupted wait is removed. */
const untilAborted = (signal: AbortSignal): Effect.Effect<void> => Effect.callback<void>((resume) => {
  const onAbort = () => resume(Effect.void);
  signal.addEventListener("abort", onAbort, { once: true });
  return Effect.sync(() => signal.removeEventListener("abort", onAbort));
});
