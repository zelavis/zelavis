import { integrationValue, unwrapIntegrationResult, presentProtocol, present, integration } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { parseJson } from "../core/json-validation.js";
import { preparedProjectRecord, projectForRemoteStart } from "./_project-record-validation.js";
import { mkdir, readFile, rm, statfs } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join, resolve } from "node:path";

import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import { createRemotePlacementLeaseStore } from "../core/agent/remote-placement.js";
import { createLocalSqliteSystemStore } from "./_sqlite-system-store.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import { createAgentProcessClient, createAgentProcessServer } from "./_agent-ipc.js";
import { createLocalProjectRuntime, type LocalProjectRuntimeOptions } from "./_local-project-runtime.js";
import {
  installRemoteProjectSnapshot,
  readPreparedRemoteProjectDigest,
} from "./_remote-project-snapshot.js";
import { createProjectDispatchHttpsServer } from "./_project-dispatch-https.js";
import { createRemoteShardHost } from "./_remote-shard-host.js";
import type { ReadLimits } from "../db/read-budget.js";
import type { ZelavisProjectLogEntry, ZelavisProjectRuntimeSnapshot } from "../project.js";
import { isStandbyWorkload } from "../core/agent/project-dispatch.js";
import { ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../platform/gateway-authority.js";

/** A separately supervised Node Agent that runs prepared Projects on this Node. */
export function createRemoteProjectAgent(options: {
  readonly dataDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly keyPem: string;
  readonly certPem: string;
  /** Read for every verification, so a refreshed set of Platform keys applies without a restart. */
  readonly trust: () => ZelavisHostOperationTrustStore;
  readonly agentId: string;
  readonly nodeId: string;
  readonly runtime?: Omit<LocalProjectRuntimeOptions, "directory" | "agent">;
  readonly shards?: { readonly readsPerShard?: number; readonly readsPerAgent?: number; readonly readPermitWaitMillis?: number;
    readonly readDeadlineMillis?: number; readonly maxReadAnswerBytes?: number;
    readonly readLimits?: Partial<ReadLimits> };
}): Promise<{
  readonly address: string;
  shardReadsServed(): number;
  /** What this Agent runs for a Project now (`standby`, `running`, `stopped`…), for diagnostics and tests. */
  status(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  /** What the Project's process here has logged, for diagnostics and tests. */
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  close(): Promise<void>;
}> { return presentProtocol(Effect.gen(function* () {
  const root = resolve(options.dataDirectory);
  const agentDirectory = join(root, "agent");
  const projectsDirectory = join(root, "projects");
  (yield* integrationValue(mkdir(agentDirectory, { recursive: true, mode: 0o700 })));
  const store = createLocalSqliteSystemStore({
    filename: join(agentDirectory, "remote-placements.sqlite"),
  });
  const hosted = createRemoteShardHost({
    dataDirectory: root, store, trust: options.trust, agentId: options.agentId, nodeId: options.nodeId, ...options.shards,
  });
  const runner = createLocalAgentProcessRunner({
    stateDirectory: join(projectsDirectory, ".agent-processes"),
  });
  let client: Awaited<ReturnType<typeof createAgentProcessClient>> | undefined;
  const leases = createRemotePlacementLeaseStore({
    store, trust: options.trust, agentId: options.agentId, nodeId: options.nodeId,
    fencePrevious: (placement) => present(integration(() => client?.fencePlacement?.(placement) ?? false)),
  });
  let runtime: ReturnType<typeof createLocalProjectRuntime> | undefined;
  let ready = false;
  // Grants and KV wait for adoption like every other command, so a shard is never served half-started.
  const shards: typeof hosted = {
    applyGrant: (token) => present(Effect.gen(function* () {
      if (!ready) throw new Error("Project Agent is still starting.");
      return yield* integrationValue(hosted.applyGrant(token));
    })),
    kv: (body) => ready ? hosted.kv(body) : Promise.resolve({ status: 503, body: { code: "busy" } }),
    reads: (body) => ready ? hosted.reads(body) : Promise.resolve({ status: 503, body: { code: "busy" } }),
    readsServed: hosted.readsServed,
    close: hosted.close,
  };
  const server = (yield* integrationValue(createProjectDispatchHttpsServer({
    host: options.host, port: options.port,
    keyPem: options.keyPem, certPem: options.certPem,
    trust: options.trust, agentId: options.agentId, nodeId: options.nodeId,
    nonceStore: store,
    shards,
    capacity: () => present(Effect.gen(function* () {
      const disk = yield* integrationValue(statfs(root));
      return { cpuCores: availableParallelism(), memoryBytes: totalmem(), diskBytes: Number(disk.bavail) * Number(disk.bsize) };
    })),
    isReady: () => ready,
    readPlacement: leases.read,
    acceptLease: (token) => present(Effect.gen(function* () {
      if (!ready) throw new Error("Project Agent is still starting.");
      return (yield* integrationValue(leases.accept(token)));
    })),
    releaseLease: leases.release,
    prepareArtifact: (projectId, body, digest) => present(Effect.gen(function* () {
      if (!ready) throw new Error("Project Agent is still starting.");
      (yield* integrationValue(installRemoteProjectSnapshot({ projectsDirectory, projectId, body, digest })));
    })),
    preparedDigest: (projectId) => readPreparedRemoteProjectDigest(projectsDirectory, projectId),
    route: (claims, request) => present(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      const route = claims.route;
      if (route === undefined) throw new Error("A routed request carries its signed route.");
      const snapshot = yield* integrationValue(runtime.status(claims.projectId));
      if (snapshot.status !== "running" || snapshot.url === undefined) throw new Error("The Project is not running here.");
      // The Project's own Gateway envelope, signed here: this Agent holds the Project's secret and the Platform does not.
      const authority = yield* integrationValue(runtime.signGatewayAuthority?.(claims.projectId, route.gateway));
      if (authority === undefined) throw new Error("The Project cannot sign a Gateway envelope here.");
      const headers = new Headers(request.headers as [string, string][]);
      for (const [name] of [...headers]) if (name.toLowerCase().startsWith("x-zelavis-")) headers.delete(name);
      headers.set(ZELAVIS_GATEWAY_AUTHORITY_HEADER, authority);
      const target = new URL(route.path, snapshot.url);
      if (target.origin !== new URL(snapshot.url).origin) throw new Error("A routed path stays on the Project's own listener.");
      const answered = yield* integrationValue(fetch(target, {
        method: route.method, headers, redirect: "manual", signal: AbortSignal.timeout(30_000),
        ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
      }));
      const body = new Uint8Array(yield* integrationValue(answered.arrayBuffer()));
      if (body.byteLength > 32 * 1024 * 1024) throw new Error("The Project answered with more than the Gateway carries.");
      return { status: answered.status, headers: [...answered.headers] as [string, string][], body };
    })),
    startStandby: (claims) => presentProtocol(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      const prepared = parseJson(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(join(projectsDirectory,
        claims.projectId, "project.json"), "utf8")))), preparedProjectRecord);
      const project = projectForRemoteStart(prepared);
      if (project.id !== claims.projectId) throw new Error("Prepared Project identity differs from dispatch.");
      if (claims.lease === undefined) throw new Error("A standby start carries the lease environment it runs under.");
      // No placement: a standby holds none. The writer lease is its fence.
      unwrapIntegrationResult(yield* Effect.result(integrationValue(runtime.startStandby!(project, undefined, { leaseEnvironment: claims.lease }))));
    }).pipe(Effect.withSpan("createRemoteProjectAgent/server/startStandby/callback"))),
    stopStandby: (claims) => present(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      // Only a process still standing by: once it has been replaced by the writer, this authority stops nothing.
      const current = yield* integrationValue(runtime.status(claims.projectId));
      if (current.status === "standby") (yield* integrationValue(runtime.stop(claims.projectId)));
    })),
    start: (claims) => { return presentProtocol(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      const prepared = parseJson(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(join(projectsDirectory,
        claims.projectId, "project.json"), "utf8")))), preparedProjectRecord);
      const project = projectForRemoteStart(prepared);
      if (project.id !== claims.projectId) throw new Error("Prepared Project identity differs from dispatch.");
      unwrapIntegrationResult(yield* Effect.result(integrationValue(runtime.start(project, {
        projectId: claims.projectId, nodeId: claims.nodeId,
        ownerSession: claims.ownerSession, epoch: claims.epoch,
      }, {
        ...(claims.lease === undefined ? {} : { leaseEnvironment: claims.lease }),
        ...(claims.appShards === undefined ? {} : { appShardEnvironment: claims.appShards }),
      }))));
    }).pipe(Effect.withSpan("createRemoteProjectAgent/server/start/callback"))); },
    stop: (claims) => present(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      (yield* integrationValue(runtime.stop(claims.projectId)));
    })),
  })));
  let processServer: Awaited<ReturnType<typeof createAgentProcessServer>> | undefined;
  try {
    unwrapIntegrationResult(yield* Effect.result(integrationValue(runner.reclaim?.())));
    const endpointDirectory = join(agentDirectory, "ipc");
    processServer = unwrapIntegrationResult(yield* Effect.result(integrationValue(createAgentProcessServer({
      directory: endpointDirectory,
      runner,
      placement: {
        // A standby holds no placement, so it is the one workload the Agent does not bind to one.
        isProjectWorkload: (workloadId) => !isStandbyWorkload(workloadId),
        read: leases.read,
      },
    }))));
    client = unwrapIntegrationResult(yield* Effect.result(integrationValue(createAgentProcessClient({ directory: endpointDirectory }))));
    runtime = createLocalProjectRuntime({
      directory: projectsDirectory,
      agent: client,
      ...options.runtime,
    });
    ready = true;
    return {
      address: server.address,
      shardReadsServed: hosted.readsServed,
      logs: (projectId: string) => present(Effect.gen(function* () {
        if (!runtime) throw new Error("Project Agent is still starting.");
        return yield* integrationValue(runtime.logs(projectId));
      })),
      status: (projectId: string) => present(Effect.gen(function* () {
        if (!runtime) throw new Error("Project Agent is still starting.");
        return yield* integrationValue(runtime.status(projectId));
      })),
      close() {
    return present(Effect.gen(function* () {
        ready = false;
        (yield* integrationValue(server.close()));
        (yield* integrationValue(hosted.close()));
        (yield* integrationValue(runtime?.close()));
        (yield* integrationValue(client?.close()));
        (yield* integrationValue(processServer?.close()));
        (yield* integrationValue(store.close?.()));
        (yield* integrationValue(rm(endpointDirectory, { recursive: true, force: true })));
      }));
  },
    };
  } catch (error) {
    ready = false;
    unwrapIntegrationResult(yield* Effect.result(integrationValue(server.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(hosted.close())));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(runtime?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(client?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(processServer?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(store.close?.())));
    throw error;
  }
}).pipe(Effect.withSpan("createRemoteProjectAgent"))); }
