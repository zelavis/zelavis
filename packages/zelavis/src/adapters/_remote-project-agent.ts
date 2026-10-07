import { integrationValue, unwrapIntegrationResult, presentProtocol, present, integration } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { parseJson } from "../core/json-validation.js";
import { preparedProjectRecord, projectForRemoteStart } from "./_project-record-validation.js";
import { mkdir, readFile, rm } from "node:fs/promises";
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

/** A separately supervised Node Agent that runs prepared Projects on this Node. */
export function createRemoteProjectAgent(options: {
  readonly dataDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly keyPem: string;
  readonly certPem: string;
  readonly trust: ZelavisHostOperationTrustStore;
  readonly agentId: string;
  readonly nodeId: string;
  readonly runtime?: Omit<LocalProjectRuntimeOptions, "directory" | "agent">;
}): Promise<{ readonly address: string; close(): Promise<void> }> { return presentProtocol(Effect.gen(function* () {
  const root = resolve(options.dataDirectory);
  const agentDirectory = join(root, "agent");
  const projectsDirectory = join(root, "projects");
  (yield* integrationValue(mkdir(agentDirectory, { recursive: true, mode: 0o700 })));
  const store = createLocalSqliteSystemStore({
    filename: join(agentDirectory, "remote-placements.sqlite"),
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
  const server = (yield* integrationValue(createProjectDispatchHttpsServer({
    host: options.host, port: options.port,
    keyPem: options.keyPem, certPem: options.certPem,
    trust: options.trust, agentId: options.agentId, nodeId: options.nodeId,
    nonceStore: store,
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
    start: (claims) => { return presentProtocol(Effect.gen(function* () {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      const prepared = parseJson(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(join(projectsDirectory,
        claims.projectId, "project.json"), "utf8")))), preparedProjectRecord);
      const project = projectForRemoteStart(prepared);
      if (project.id !== claims.projectId) throw new Error("Prepared Project identity differs from dispatch.");
      unwrapIntegrationResult(yield* Effect.result(integrationValue(runtime.start(project, {
        projectId: claims.projectId, nodeId: claims.nodeId,
        ownerSession: claims.ownerSession, epoch: claims.epoch,
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
        isProjectWorkload: () => true,
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
      close() {
    return present(Effect.gen(function* () {
        ready = false;
        (yield* integrationValue(server.close()));
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
    unwrapIntegrationResult(yield* Effect.result(integrationValue(runtime?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(client?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(processServer?.close().catch(() => undefined))));
    unwrapIntegrationResult(yield* Effect.result(integrationValue(store.close?.())));
    throw error;
  }
}).pipe(Effect.withSpan("createRemoteProjectAgent"))); }
