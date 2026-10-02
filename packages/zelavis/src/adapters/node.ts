import { acquireLocalDataOwnership, acquireLocalEdgeOwnership, type LocalOwnershipLease } from "./_local-ownership.js";
import { join, resolve } from "node:path";
import { loadPlatformMasterSecret } from "../platform/master-secret.js";
import { readFile } from "node:fs/promises";
import {
  defineAdapter,
  type ZelavisOptions,
  type ZelavisResolvedPlatformOptions,
  type ZelavisServiceRegistryEntry,
  type ZelavisServiceSetupContext,
} from "../index.js";
import { createAgentProcessClient } from "./_agent-ipc.js";
import { createHttpsProjectDispatcher, probeProjectAgent } from "./_project-dispatch-https.js";
import type { ZelavisProjectDispatcher } from "../project.js";
import type { FabricNode } from "../core/fabric/index.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import { createAgentRemoteEnvironment, REMOTE_ENVIRONMENT_WORKLOAD_PREFIX } from "./_agent-remote-environment.js";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
export { createAgentRemoteEnvironment } from "./_agent-remote-environment.js";
export {
  createHttpsProjectDispatcher,
  createProjectDispatchHttpsServer,
  type ProjectDispatchHttpsServer,
} from "./_project-dispatch-https.js";
export { createRemoteProjectAgent } from "./_remote-project-agent.js";
import { createLocalSqliteSystemStore } from "./_sqlite-system-store.js";
import {
  createLocalProjectRuntime,
  type LocalProjectRuntimeOptions,
} from "./_local-project-runtime.js";
import {
  createLocalFileStorage,
  createMemoryKeyValueStore,
} from "./_shared.js";
import {
  normalizeDataDirectory,
  createLocalFrontendDirectoryResolver,
  createLocalServiceSources,
  createLocalRuntimeServiceImporter,
  createLocalRuntimeServicePackageInstaller,
  type LocalRuntimeServiceOptions,
} from "./_local-runtime.js";
import { createBuiltinDeploymentBackends } from "../backends/index.js";
import { createNodeBackendHostProbes } from "./_node-backend-host.js";
import { installAsyncPluginContextStorage } from "./_async-plugin-context.js";
import { createNodeUpdateControl } from "./_node-updates.js";
import { readOrCreatePlatformAuthorityKey } from "./_platform-authority-key.js";
import {
  createHostOperationBroker,
  type ZelavisHostOperationBroker,
} from "../platform/host-operations.js";
import {
  createZelavisEdgeManager,
  createZelavisEdgeRouteStore,
  createZelavisCertificateController,
  createTraefikEdgeAdapter,
  createTraefikCertificateDistributor,
  createAgentHostOperationInvoker,
  toPublicationSummary,
  type ZelavisEdgeManager,
  type ZelavisEdgeRouteStore,
  type ZelavisCertificateController,
} from "../edge/index.js";
export {
  resolveLocalPackageManifest,
  createLocalRuntimeServiceManifestResolver,
} from "./_local-runtime.js";
export {
  createNodeFileArtifactStore,
  type NodeFileArtifactStoreOptions,
} from "./_node-artifact-store.js";
export {
  createNodeInstallationUninstaller,
  type NodeInstallationUninstallerOptions,
} from "./_node-installation-uninstaller.js";

export interface NodeAdapterDatabaseOptions {
  /** Directory holding one SQLite file per shard. */
  directory?: string;
  /**
   * Adopted only the first time a Project opens.
   *
   * The stored partition map is authoritative afterwards, so a later start
   * naming a different shard list cannot re-place ranges out from under the
   * data already on them.
   */
  shards?: readonly string[];
  virtualRanges?: number;
}

export type NodeAdapterServiceOptions = LocalRuntimeServiceOptions & {
  catalog?: readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
  /**
   * Folder on this server that services are dropped into.
   *
   * Defaults to `<dataDirectory>/services`. It lives here rather than in an
   * option of its own because two options both named for services is how the
   * folder and the registry drifted apart in the first place.
   */
  directory?: string;
};

export interface NodeAdapterSystemStoreOptions {
  filename?: string;
}

export interface NodeAdapterProjectOptions {
  directory?: string;
  startupTimeoutMs?: number;
  startupConcurrency?: number;
  shutdownConcurrency?: number;
  logLimit?: number;
  /**
   * Recipes that provide their own runtime (for example `@zelavis/wordpress`),
   * enabled by this host, with the options each runtime is given. Marketplace
   * allow-listed recipes and, in development, packages in an official-services
   * checkout are trusted without being listed here.
   */
  recipeRuntimes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Run Project processes through a separately supervised Agent.
   *
   * The directory holding its socket and token — what `zelavis agent` created.
   * Omit it and Projects run in the Platform process, which is the default and
   * needs nothing supervised alongside it.
   *
   * Note what this does not yet buy: a Platform restart still stops nothing and
   * adopts nothing. The Agent keeps the processes running, but the new Platform
   * has no handles to them, so it reclaims them and starts fresh.
   */
  agentEndpoint?: string;
  /** Remote Node Agents reached over pinned TLS with signed Project grants. */
  remoteDispatch?: {
    readonly localNodeId: string;
    readonly nodes: Readonly<Record<string, {
      readonly url: string;
      readonly agentId: string;
      readonly caFile: string;
    }>>;
  };
}

export interface NodeAdapterOptions {
  role?: "platform" | "project";
  dataDirectory?: string;
  database?: false | NodeAdapterDatabaseOptions;
  systemStore?: false | NodeAdapterSystemStoreOptions;
  projects?: false | NodeAdapterProjectOptions;
  /**
   * Services: the registry, and the folder they are dropped into.
   *
   * Set to `false` to scan nothing, which is what an installation composing
   * every service itself wants.
   */
  services?: false | NodeAdapterServiceOptions;
  files?: false | {
    rootDirectory?: string;
  };
  kv?: false | {
    kind?: "memory";
  };
  edge?: false;
  /** Installer-selected host authority, never inferred from an HTTP request. */
  installation?: { prefix: string; instance: string; edge: boolean };
}

export const createNodeServicePackageInstaller = createLocalRuntimeServicePackageInstaller;
export const createNodeServiceImporter = createLocalRuntimeServiceImporter;

export function nodeAdapter(options: NodeAdapterOptions = {}) {
  installAsyncPluginContextStorage();
  let ownership: Promise<LocalOwnershipLease> | undefined;
  let edgeOwnership: Promise<LocalOwnershipLease> | undefined;
  let ownerOptions: ZelavisOptions | undefined;
  const stores = new Set<{ close?(): void | Promise<void> }>();
  let projectRuntime: ReturnType<typeof createLocalProjectRuntime> | undefined;

  return defineAdapter({
    name: "node",
    async close(requester) {
      if (requester && ownerOptions && requester !== ownerOptions) return;
      await Promise.all([...stores].map((store) => store.close?.()));
      stores.clear();
      const lease = await ownership?.catch(() => undefined);
      await lease?.release();
      ownership = undefined;
      await (await edgeOwnership?.catch(() => undefined))?.release();
      edgeOwnership = undefined;
      ownerOptions = undefined;
    },
    async resolve(
      _constructorOptions: ZelavisOptions,
    ): Promise<ZelavisResolvedPlatformOptions> {
      const dataDirectory = normalizeDataDirectory(options.dataDirectory);
      const isProjectRuntime = options.role === "project";
      if (!isProjectRuntime && options.systemStore !== false) {
        if (ownerOptions && ownerOptions !== _constructorOptions) throw new Error("This adapter already owns a Platform; close it before creating another.");
        ownerOptions = _constructorOptions;
        ownership ??= acquireLocalDataOwnership(dataDirectory);
        await ownership;
        if (options.installation?.edge && options.edge !== false) {
          edgeOwnership ??= acquireLocalEdgeOwnership({ ...options.installation, dataDirectory });
          await edgeOwnership;
        }
      }
      const databaseOptions =
        options.database ?? (isProjectRuntime ? {} : false);
      const nextSubsystems: Record<string, unknown> = isProjectRuntime
        ? { fabric: false }
        : {
            database: false,
            // The frontend service stays on for the Platform: with the
            // dashboard enabled it makes `/` lead there instead of returning a
            // 404 that reads as a broken installation.
            storage: false,
            workloads: false,
          };

      const systemStoreOptions =
        options.systemStore === false ? undefined : options.systemStore;
      const systemStoreFilename = systemStoreOptions?.filename
        ? resolve(systemStoreOptions.filename)
        : join(
            dataDirectory,
            isProjectRuntime ? "runtime" : "system",
            "zelavis.sqlite",
          );
      const systemStore =
        options.systemStore === false
          ? undefined
          : createLocalSqliteSystemStore({ filename: systemStoreFilename });
      if (systemStore) stores.add(systemStore);

      if (databaseOptions !== false) {
        // The topology is no longer resolved here: the partition map lives in
        // the database's own store, versioned and fenced like any other write,
        // so a second copy in the System Store could only disagree with it.
        nextSubsystems.database = {
          directory: databaseOptions.directory
            ? resolve(databaseOptions.directory)
            : join(dataDirectory, "data", "primary", "shards"),
          nodeId: "local",
          ...(databaseOptions.shards ? { shards: databaseOptions.shards } : {}),
          ...(databaseOptions.virtualRanges === undefined
            ? {}
            : { virtualRanges: databaseOptions.virtualRanges }),
        };
      }

      const serviceOptions = options.services === false ? undefined : options.services;
      const serviceDirectory = join(dataDirectory, "services");
      const normalizedProjectOptions =
        options.projects === false ? undefined : options.projects;
      const projectsEnabled =
        options.projects !== false &&
        (!isProjectRuntime || normalizedProjectOptions !== undefined);
      const projectOptions = projectsEnabled ? normalizedProjectOptions : undefined;
      const fileStorage =
        options.files === false
          ? undefined
          : createLocalFileStorage(
              options.files?.rootDirectory
                ? resolve(options.files.rootDirectory)
                : join(dataDirectory, "files"),
            );
      const serviceSources = await createLocalServiceSources({
        dataDirectory,
        services: options.services,
        isProjectRuntime,
        fileStorage,
        systemStore,
        ...(projectsEnabled && !isProjectRuntime
          ? {
              projectsDirectory: projectOptions?.directory
                ? resolve(projectOptions.directory)
                : join(dataDirectory, "projects"),
            }
          : {}),
      });
      let agentClient: Awaited<ReturnType<typeof createAgentProcessClient>> | undefined;
      let agentRunner: ZelavisAgentProcessRunner | undefined;
      let platformAuthority: Awaited<ReturnType<typeof readOrCreatePlatformAuthorityKey>> | undefined;
      let projectDispatcher: ZelavisProjectDispatcher | undefined;
      if (projectsEnabled && !projectRuntime) {
        const runtimeOptions: LocalProjectRuntimeOptions = {
          directory: projectOptions?.directory
            ? resolve(projectOptions.directory)
            : join(dataDirectory, "projects"),
          ...(projectOptions?.startupTimeoutMs === undefined
            ? {}
            : { startupTimeoutMs: projectOptions.startupTimeoutMs }),
          ...(projectOptions?.startupConcurrency === undefined
            ? {}
            : { startupConcurrency: projectOptions.startupConcurrency }),
          ...(projectOptions?.shutdownConcurrency === undefined
            ? {}
            : { shutdownConcurrency: projectOptions.shutdownConcurrency }),
          ...(projectOptions?.logLimit === undefined
            ? {}
            : { logLimit: projectOptions.logLimit }),
          // Recipes whose package ships their own runtime. The marketplace's
          // allow-list (or a development checkout) says which may, and the host
          // may also enable some by name.
          recipeRuntimes: {
            ...(serviceSources.recipePackageDirectory
              ? { packageDirectory: serviceSources.recipePackageDirectory }
              : {}),
            trusted: async (name: string) =>
              projectOptions?.recipeRuntimes?.[name] !== undefined ||
              ((await serviceSources.recipeRuntimeTrusted?.(name)) ?? false),
          },
          ...(projectOptions?.recipeRuntimes
            ? { recipeRuntimeOptions: projectOptions.recipeRuntimes }
            : {}),
          ...(serviceSources.recipePackageDirectory
            ? { recipePackageDirectory: serviceSources.recipePackageDirectory }
            : {}),
          ...(serviceSources.marketplace
            ? { handDownAllowlist: (directory: string) => serviceSources.marketplace!.handDown(directory) }
            : {}),
          // Without this a frontend Project cannot start at all: the driver
          // refuses rather than falling through to the Zelavis runner and
          // failing in a way that looks like a broken frontend.
          serverFrontend: {
            // The same directory the package installer writes to. Resolving
            // against anything else would look for installed packages where
            // none are.
            resolveFrontendDirectory: createLocalFrontendDirectoryResolver({
              directory: serviceDirectory,
              ...(serviceOptions ?? {}),
            }),
          },
        };
        // The Agent is resolved here rather than left to the driver so the
        // sweep below can run: the adapter's `resolve` is async, and a driver
        // constructor is not.
        // The authority key exists before the Agent is contacted, so an Agent
        // started first finds the trust file as soon as the Platform starts.
        if ((projectOptions?.agentEndpoint || projectOptions?.remoteDispatch) &&
            systemStore && !isProjectRuntime) {
          platformAuthority = await readOrCreatePlatformAuthorityKey(
            join(dataDirectory, "system", "agent-authority"),
          );
        }
        agentClient = projectOptions?.agentEndpoint
          ? await createAgentProcessClient({
              directory: resolve(projectOptions.agentEndpoint),
            })
          : undefined;
        runtimeOptions.agent = agentClient
          ? // Fails rather than falling back to in-process execution: a host
            // that asked for a supervised Agent and silently got Projects
            // inside the Platform has the opposite of what it configured, and
            // would only find out when the Platform next died.
            agentClient
          : createLocalAgentProcessRunner({
              stateDirectory: join(runtimeOptions.directory, ".agent-processes"),
            });
        agentRunner = runtimeOptions.agent;

        projectRuntime = createLocalProjectRuntime(runtimeOptions);
        if (projectOptions?.remoteDispatch && platformAuthority) {
          const destinations = Object.fromEntries(await Promise.all(
            Object.entries(projectOptions.remoteDispatch.nodes).map(async ([nodeId, node]) => [
              nodeId,
              { url: node.url, agentId: node.agentId,
                caPem: await readFile(resolve(node.caFile), "utf8") },
            ] as const),
          ));
          projectDispatcher = createHttpsProjectDispatcher({
            localNodeId: projectOptions.remoteDispatch.localNodeId,
            projectsDirectory: runtimeOptions.directory,
            destinations,
            keyId: platformAuthority.signer.keyId,
            privateKey: platformAuthority.signer.privateKey,
          });
          const localNodeId = projectOptions.remoteDispatch.localNodeId;
          if (!localNodeId || destinations[localNodeId]) {
            throw new Error("Remote dispatch needs a distinct local Fabric Node id.");
          }
          const localNode = {
            id: localNodeId, status: "ready" as const,
            roles: ["gateway", "control", "worker"] as const,
            runtimeEngine: "node", runtimeDriver: "local-project",
          };
          nextSubsystems.fabric = {
            localNode,
            inventory: {
              nodes: async () => {
                const entries = Object.entries(destinations);
                const nodes: FabricNode[] = [localNode];
                for (let offset = 0; offset < entries.length; offset += 8) {
                  const batch = await Promise.all(entries.slice(offset, offset + 8)
                    .map(async ([nodeId, target]) => ({
                      id: nodeId,
                      status: await probeProjectAgent(target, nodeId)
                        ? "ready" as const : "unavailable" as const,
                      roles: ["worker"] as const,
                      runtimeEngine: "node", runtimeDriver: "local-project",
                    })));
                  nodes.push(...batch);
                }
                return nodes;
              },
            },
          };
        }

        // Order matters. Adopt first, so a Project the Agent is still running
        // is taken over rather than killed; reclaim second, so what is left
        // afterwards is what nothing can drive. Reclaiming first would stop
        // every Project on the host and then start them again, which is the
        // opposite of what running the Agent separately is for.
        await projectRuntime.adopt?.().catch(() => undefined);

        // What remains is unowned: processes from a crashed Platform that no
        // driver claimed. Reconciliation would reclaim the Projects it
        // restarts, but a Project the operator has since stopped is never
        // started again — and so would never be reclaimed at all.
        await runtimeOptions.agent.reclaim?.(undefined, {
          // Detached environment processes still have replayable pipes in the
          // Agent and are reclaimed by their persisted session, not as orphaned
          // Project runtimes during Platform boot.
          preservePrefixes: [REMOTE_ENVIRONMENT_WORKLOAD_PREFIX],
        }).catch(() => undefined);
      }
      // Host operations are requestable only through a supervised Agent,
      // and only the Platform holds the key the Agent trusts.
      let hostOperations: ZelavisHostOperationBroker | undefined;
      if (agentClient && platformAuthority && systemStore) {
        hostOperations = createHostOperationBroker({
          agent: agentClient,
          signer: platformAuthority.signer,
          store: systemStore,
        });
      }

      let edgeManager: ZelavisEdgeManager | undefined;
      let edgeRoutes: ZelavisEdgeRouteStore | undefined;
      let edgeCertificates: ZelavisCertificateController | undefined;
      if (options.edge !== false && options.installation?.edge !== false && !isProjectRuntime && systemStore) {
        edgeRoutes = createZelavisEdgeRouteStore({ store: systemStore });
        const masterSecret = await loadPlatformMasterSecret(systemStore);
        edgeCertificates = createZelavisCertificateController({
          store: systemStore,
          masterSecret,
        });

        if (hostOperations && agentClient) {
          const invoker = createAgentHostOperationInvoker({
            broker: hostOperations,
            agent: agentClient,
          });
          const traefikAdapter = createTraefikEdgeAdapter({
            invoker,
            routeStore: edgeRoutes,
          });
          const traefikCerts = createTraefikCertificateDistributor({
            invoker,
            certificateResolver: async (ref) => {
              const resolved = await edgeCertificates?.resolveCertificate(ref);
              return resolved ? { certPem: resolved.certPem, keyPem: resolved.keyPem } : undefined;
            },
          });
          const routeStore = edgeRoutes;
          edgeManager = createZelavisEdgeManager({
            store: systemStore,
            defaultAdapterId: "traefik",
            adapters: [traefikAdapter],
            certificates: traefikCerts,
            getPublication: async () => {
              const current = await routeStore.getCurrentPublication();
              return current ? toPublicationSummary(current) : undefined;
            },
          });
          await edgeManager.reconcile().catch(() => undefined);
        }
      }

      const remoteEnvironment = !isProjectRuntime && agentRunner
        ? createAgentRemoteEnvironment({ runner: agentRunner })
        : undefined;

      return {
        subsystems: nextSubsystems,
        role: isProjectRuntime ? "project" : "platform",
        ...(serviceSources.bundleStore ? { bundleStore: serviceSources.bundleStore } : {}),
        serviceRegistry: serviceSources.serviceRegistry,
        ...(projectDispatcher ? { projectDispatcher } : {}),
        resources: {
          systemStore,
          projectRuntime: projectsEnabled ? projectRuntime : undefined,
          deploymentBackends: isProjectRuntime
            ? undefined
            : createBuiltinDeploymentBackends({
                host: createNodeBackendHostProbes(),
                nativeProjectRuntime: projectsEnabled ? projectRuntime : undefined,
              }),
          ...(hostOperations ? { hostOperations } : {}),
          ...(remoteEnvironment ? { remoteEnvironment } : {}),
          ...(edgeManager ? { edge: edgeManager } : {}),
          ...(edgeRoutes ? { edgeRoutes } : {}),
          ...(edgeCertificates ? { edgeCertificates } : {}),
          kv: options.kv === false ? undefined : createMemoryKeyValueStore(),
          files: fileStorage,
          servicePackages: serviceSources.servicePackages,
          ...(serviceSources.marketplace ? { marketplace: serviceSources.marketplace.control } : {}),
          ...(!isProjectRuntime && systemStore ? { updates: createNodeUpdateControl({ dataDirectory }) } : {}),
        },
        metadata: {
          runtime: "node",
          role: isProjectRuntime ? "project" : "platform",
          ...(systemStore
            ? { systemStore: systemStoreFilename }
            : {}),
          ...(projectRuntime ? { projectRuntime: projectRuntime.name } : {}),
        },
      };
    },
  });
}
