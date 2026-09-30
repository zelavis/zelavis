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
import type { ZelavisProjectRecord } from "../project.js";

/** A separately supervised Node Agent that runs prepared Projects on this Node. */
export async function createRemoteProjectAgent(options: {
  readonly dataDirectory: string;
  readonly host: string;
  readonly port: number;
  readonly keyPem: string;
  readonly certPem: string;
  readonly trust: ZelavisHostOperationTrustStore;
  readonly agentId: string;
  readonly nodeId: string;
  readonly runtime?: Omit<LocalProjectRuntimeOptions, "directory" | "agent">;
}): Promise<{ readonly address: string; close(): Promise<void> }> {
  const root = resolve(options.dataDirectory);
  const agentDirectory = join(root, "agent");
  const projectsDirectory = join(root, "projects");
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const store = createLocalSqliteSystemStore({
    filename: join(agentDirectory, "remote-placements.sqlite"),
  });
  const runner = createLocalAgentProcessRunner({
    stateDirectory: join(projectsDirectory, ".agent-processes"),
  });
  let client: Awaited<ReturnType<typeof createAgentProcessClient>> | undefined;
  const leases = createRemotePlacementLeaseStore({
    store, trust: options.trust, agentId: options.agentId, nodeId: options.nodeId,
    fencePrevious: async (placement) => client?.fencePlacement?.(placement) ?? false,
  });
  let runtime: ReturnType<typeof createLocalProjectRuntime> | undefined;
  let ready = false;
  const server = await createProjectDispatchHttpsServer({
    host: options.host, port: options.port,
    keyPem: options.keyPem, certPem: options.certPem,
    trust: options.trust, agentId: options.agentId, nodeId: options.nodeId,
    nonceStore: store,
    isReady: () => ready,
    readPlacement: leases.read,
    acceptLease: async (token) => {
      if (!ready) throw new Error("Project Agent is still starting.");
      return leases.accept(token);
    },
    releaseLease: leases.release,
    prepareArtifact: async (projectId, body, digest) => {
      if (!ready) throw new Error("Project Agent is still starting.");
      await installRemoteProjectSnapshot({ projectsDirectory, projectId, body, digest });
    },
    preparedDigest: (projectId) => readPreparedRemoteProjectDigest(projectsDirectory, projectId),
    start: async (claims) => {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      const project = JSON.parse(await readFile(join(projectsDirectory,
        claims.projectId, "project.json"), "utf8")) as ZelavisProjectRecord;
      if (project.id !== claims.projectId) throw new Error("Prepared Project identity differs from dispatch.");
      await runtime.start(project, {
        projectId: claims.projectId, nodeId: claims.nodeId,
        ownerSession: claims.ownerSession, epoch: claims.epoch,
      });
    },
    stop: async (claims) => {
      if (!ready || !runtime) throw new Error("Project Agent is still starting.");
      await runtime.stop(claims.projectId);
    },
  });
  let processServer: Awaited<ReturnType<typeof createAgentProcessServer>> | undefined;
  try {
    await runner.reclaim?.();
    const endpointDirectory = join(agentDirectory, "ipc");
    processServer = await createAgentProcessServer({
      directory: endpointDirectory,
      runner,
      placement: {
        isProjectWorkload: () => true,
        read: leases.read,
      },
    });
    client = await createAgentProcessClient({ directory: endpointDirectory });
    runtime = createLocalProjectRuntime({
      directory: projectsDirectory,
      agent: client,
      ...options.runtime,
    });
    ready = true;
    return {
      address: server.address,
      async close() {
        ready = false;
        await server.close();
        await runtime?.close();
        await client?.close();
        await processServer?.close();
        await store.close?.();
        await rm(endpointDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    ready = false;
    await server.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await processServer?.close().catch(() => undefined);
    await store.close?.();
    throw error;
  }
}
