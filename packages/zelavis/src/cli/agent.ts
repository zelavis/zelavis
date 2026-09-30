/**
 * `zelavis agent` — run the Agent as its own process.
 *
 * Deliberately a separate command rather than something `zelavis serve` starts.
 * An Agent the Platform spawns shares the Platform's fate, which is the exact
 * property this is meant to break: the operator supervises it — systemd,
 * launchd, whatever the host uses — so a Platform restart is not a restart of
 * everything the Platform was running.
 *
 * It runs until it is signalled, then stops the processes it owns. Stopping
 * them is the right shutdown behaviour for a supervisor going away on purpose:
 * a supervisor that exits leaving unsupervised children behind is the leak
 * this whole line of work exists to close.
 */
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveCliDataDirectory } from "./data-directory.js";
import { createAgentProcessServer } from "../adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../adapters/_agent-process-runner.js";
import { createLocalSqliteSystemStore } from "../adapters/_sqlite-system-store.js";
import { REMOTE_ENVIRONMENT_WORKLOAD_PREFIX } from "../adapters/_agent-remote-environment.js";
import { readLocalProjectPlacementLease } from "../platform/project-placement-authority.js";
import { createRemoteProjectAgent } from "../adapters/_remote-project-agent.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import {
  createAgentHostOperationService,
  type AgentHostOperationService,
} from "../adapters/_agent-host-operations.js";
import { prepareDelegatedCgroupLayout } from "../adapters/_linux-cgroup-supervisor.js";

export interface RunAgentCommandOptions {
  /** Defaults to the same `.zelavis` directory the Platform uses. */
  readonly dataDirectory?: string;
  /** Injected by tests; production waits for a signal. */
  readonly signal?: AbortSignal;
  /**
   * Installed signed host operations. Without it the Agent runs Project
   * processes only and refuses operation requests.
   */
  readonly operationsRoot?: string;
  /** Trust store verifying operation signatures; required with `operationsRoot`. */
  readonly operationTrust?: string;
  /** Platform authority public keys; required with `operationsRoot`. */
  readonly platformAuthority?: string;
  /** Require root-owned trust store, operation tree and interpreters. */
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

export async function runAgentCommand(
  options: RunAgentCommandOptions & { readonly onReady?: RunAgentCommandReady } = {},
): Promise<void> {
  const dataDirectory = resolveCliDataDirectory(options.dataDirectory);
  if (options.remoteProjectConfig) {
    if (options.operationsRoot || options.operationTrust || options.platformAuthority ||
        options.placementStore) {
      throw new Error("Remote Project Agent config cannot be combined with local Agent options.");
    }
    const file = resolve(options.remoteProjectConfig);
    const config = JSON.parse(await readFile(file, "utf8")) as {
      host?: unknown; port?: unknown; keyFile?: unknown; certFile?: unknown;
      trustFile?: unknown; agentId?: unknown; nodeId?: unknown;
    };
    if (typeof config.host !== "string" || typeof config.port !== "number" ||
        typeof config.keyFile !== "string" || typeof config.certFile !== "string" ||
        typeof config.trustFile !== "string" || typeof config.agentId !== "string" ||
        typeof config.nodeId !== "string") {
      throw new Error("Remote Project Agent config needs host, port, keyFile, certFile, trustFile, agentId and nodeId.");
    }
    const relativeFile = (path: string) => resolve(dirname(file), path);
    const [keyPem, certPem, trustText] = await Promise.all([
      readFile(relativeFile(config.keyFile), "utf8"),
      readFile(relativeFile(config.certFile), "utf8"),
      readFile(relativeFile(config.trustFile), "utf8"),
    ]);
    const trust = JSON.parse(trustText) as ZelavisHostOperationTrustStore;
    if (!Array.isArray(trust.keys) || trust.keys.length === 0) {
      throw new Error("Remote Project Agent trust file has no Platform keys.");
    }
    const remote = await createRemoteProjectAgent({
      dataDirectory, host: config.host, port: config.port,
      keyPem, certPem, trust, agentId: config.agentId, nodeId: config.nodeId,
    });
    console.log(`Zelavis Project Agent listening on ${remote.address}`);
    if (options.signal) {
      if (!options.signal.aborted) {
        await new Promise<void>((resolveAborted) => options.signal!.addEventListener(
          "abort", () => resolveAborted(), { once: true }));
      }
      await remote.close();
      return;
    }
    await new Promise<void>((resolveStopped) => {
      const stop = () => { void remote.close().finally(resolveStopped); };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  const endpointDirectory = join(dataDirectory, "agent");

  const runner = createLocalAgentProcessRunner({
    // The same records the in-process runner keeps, in the same place, so an
    // installation that switches between the two does not lose track of what
    // the other started.
    stateDirectory: join(dataDirectory, "projects", ".agent-processes"),
  });

  // Anything a previous Agent or Platform left running is stopped before this
  // one starts accepting work, so the first Project start does not race a
  // leftover holding its port.
  const reclaimed = (await runner.reclaim?.()) ?? 0;
  if (reclaimed > 0) {
    console.log(`Reclaimed ${reclaimed} process(es) left by an earlier run.`);
  }

  let operations: AgentHostOperationService | undefined;
  if (options.operationsRoot) {
    if (!options.operationTrust) {
      throw new Error("--operations-root requires --operation-trust.");
    }
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
      ? (await prepareDelegatedCgroupLayout({
          controllers: [
            ...(limits.memoryMaxBytes !== undefined ? ["memory" as const] : []),
            ...(limits.pidsMax !== undefined ? ["pids" as const] : []),
          ],
        })).operations
      : options.operationCgroup;
    operations = await createAgentHostOperationService({
      directory: join(dataDirectory, "agent-operations"),
      operationsRoot: resolve(options.operationsRoot),
      trustFile: resolve(options.operationTrust),
      platformAuthorityFile: resolve(options.platformAuthority),
      requireRootOwned: options.requireRootOwnedOperations === true,
      ...(cgroupRoot
        ? { supervision: { kind: "cgroup-v2" as const, root: cgroupRoot, limits } }
        : {}),
    });
    const platformAuthorityPresent = await access(resolve(options.platformAuthority)).then(() => true, () => false);
    if (!platformAuthorityPresent) {
      console.log(
        `Platform authority file ${options.platformAuthority} does not exist yet; every operation request is refused until the Platform creates it.`,
      );
    }
    console.log(
      `Host operations: ${operations.registered.length} installed (${cgroupRoot ? `cgroup ${cgroupRoot}` : "process-group supervision"}).`,
    );
  } else if (options.operationCgroup || options.operationTrust || options.platformAuthority) {
    throw new Error("Host operation options require --operations-root.");
  }

  const placementStore = createLocalSqliteSystemStore({
    filename: resolve(options.placementStore ?? join(dataDirectory, "system", "zelavis.sqlite")),
  });
  const server = await createAgentProcessServer({
    directory: endpointDirectory,
    runner,
    ...(operations ? { operations } : {}),
    placement: {
      isProjectWorkload: (id: string) => !id.startsWith(REMOTE_ENVIRONMENT_WORKLOAD_PREFIX),
      read: (projectId: string) => readLocalProjectPlacementLease(placementStore, projectId),
    },
  });

  console.log(`Zelavis Agent listening on ${server.socketPath}`);
  options.onReady?.({ socketPath: server.socketPath, ...(operations ? { operations } : {}) });

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= server.close().finally(
      async () => { await placementStore?.close?.(); },
    ).then(
      () => undefined,
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      },
    );
    return closing;
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (options.signal) {
    if (options.signal.aborted) {
      await shutdown();
      return;
    }
    await new Promise<void>((resolveAborted) => {
      options.signal!.addEventListener("abort", () => resolveAborted(), {
        once: true,
      });
    });
    await shutdown();
    return;
  }

  await new Promise<void>((resolveClosed) => {
    const poll = setInterval(() => {
      if (!closing) return;
      clearInterval(poll);
      void closing.then(() => resolveClosed());
    }, 100);
  });
}
