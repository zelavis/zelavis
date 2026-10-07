import { isUnknown, optional, objectFields, recordOf, parseJson } from "../core/json-validation.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { Zelavis, defineAdapter, type ZelavisPlatformResources } from "../index.js";
import { nodeAdapter, type NodeAdapterProjectOptions } from "./node.js";
import { provideHostPackagesTo } from "./_service-resolution.js";
import { resolveBundledServiceDirectory } from "./_local-runtime.js";
import { resolveBundledFrontend } from "../cli/bundled-frontend.js";
import { effectOperations, evaluate, integration, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectRecord, ZelavisProjectRuntimeDriver } from "../project.js";
import { createZelavisEdgePreviews, type ZelavisEdgePreviews } from "../edge/previews.js";
import { requestNodeRuntimeControl, NODE_RUNTIME_PREVIEW_ID, NODE_RUNTIME_PREVIEW_KEY } from "./_node-runtime-control.js";
import type { NodeRuntimeEngine } from "./_node-runtime-worker.js";
import { ensureProductionEdge } from "../edge/production.js";

export const prepare = Effect.fn("PlatformEngine.prepare")(function* (configuration: Readonly<Record<string, unknown>>): Effect.fn.Return<NodeRuntimeEngine, TaggedFailure> {
  const options = yield* evaluate(() => {
    if (typeof configuration.dataDirectory !== "string" || typeof configuration.host !== "string") throw new Error("Platform engine requires data and ingress configuration.");
    if (configuration.custody !== undefined) {
      const custody = configuration.custody as Record<string, unknown>;
      if (!custody || typeof custody.ownerSession !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(custody.ownerSession) || typeof custody.endpoint !== "string" || custody.endpoint !== resolve(configuration.dataDirectory, "runtime-control.sock") || typeof custody.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(custody.token) || typeof custody.preserveOnShutdown !== "boolean") throw new Error("Platform engine requires qualified persistent host custody.");
    }
    return { dataDirectory: resolve(configuration.dataDirectory), host: configuration.host,
      servicesDirectory: typeof configuration.servicesDirectory === "string" ? resolve(configuration.servicesDirectory) : undefined,
      custody: configuration.custody as { ownerSession: string; endpoint: string; token: string; preserveOnShutdown: boolean } | undefined,
      installation: configuration.installation as { prefix: string; instance: string; edge: boolean } | undefined,
      enrollmentEndpoint: configuration.enrollmentEndpoint as { url: string; fingerprint: string } | undefined };
  });
  const frontend = yield* integration(() => resolveBundledFrontend({ bundledDirectory: name => {
    const directory = resolveBundledServiceDirectory(name);
    if (directory) provideHostPackagesTo(directory);
    return directory;
  } }));
  let remoteDispatch: NodeAdapterProjectOptions["remoteDispatch"];
  const dispatchFile = process.env.ZELAVIS_PROJECT_DISPATCH_CONFIG;
  if (dispatchFile) {
    const file = resolve(dispatchFile);
    const source = yield* integration(() => readFile(file, "utf8"));
    remoteDispatch = yield* evaluate(() => {
      const input = parseJson(source, objectFields<{ localNodeId?: unknown; nodes?: Record<string, { url?: unknown; agentId?: unknown; caFile?: unknown }> }>({localNodeId: optional(isUnknown), nodes: optional(recordOf(objectFields<{ url?: unknown; agentId?: unknown; caFile?: unknown }>({url: optional(isUnknown), agentId: optional(isUnknown), caFile: optional(isUnknown)})))}));
      if (typeof input.localNodeId !== "string" || !input.nodes || typeof input.nodes !== "object" || Array.isArray(input.nodes) ||
        Object.values(input.nodes).some(node => !node || typeof node.url !== "string" || typeof node.agentId !== "string" || typeof node.caFile !== "string"))
        throw new Error("Project dispatch config needs localNodeId and TLS-pinned Agent nodes.");
      return { localNodeId: input.localNodeId, nodes: Object.fromEntries(Object.entries(input.nodes).map(([nodeId, node]) => [nodeId,
        { url: node.url as string, agentId: node.agentId as string, caFile: resolve(dirname(file), node.caFile as string) }])) };
    });
  }
  return {
    open: Effect.fn("PlatformEngine.open")(function* () {
      let resources: ZelavisPlatformResources | undefined;
      let previews: ZelavisEdgePreviews | undefined;
      let incomingContinuity: ZelavisProjectRecord[] = [];
      let initialProbe = true;
      const previewFetch = new Map<string, (request: Request) => Promise<Response>>();
      // Abort and handover leave independently supervised Projects in the host's
      // custody. An explicit supervisor shutdown closes the whole fleet instead.
      let preserve = Boolean(options.custody);
      const custody = options.custody ? { ownerSession: options.custody.ownerSession, preserveOnClose: () => preserve } : undefined;
      const wrapped = new Map<ZelavisProjectRuntimeDriver, ZelavisProjectRuntimeDriver>();
      const wrap = (driver: ZelavisProjectRuntimeDriver) => {
        const existing = wrapped.get(driver);
        if (existing) return existing;
        const selected = { ...driver, ...(custody ? { custody } : {}),
          close: () => present(preserve ? (effectOperations(driver).detach?.() ?? evaluate(() => { throw new Error("Project driver cannot relinquish Agent custody."); })) : effectOperations(driver).close()),
        };
        wrapped.set(driver, selected); return selected;
      };
      const adapter = nodeAdapter({ dataDirectory: options.dataDirectory,
          ...(process.env.ZELAVIS_HOST_OPERATIONS_ENDPOINT ? { hostOperationsEndpoint: process.env.ZELAVIS_HOST_OPERATIONS_ENDPOINT } : {}),
          ...(options.installation ? { installation: options.installation, ...(!options.installation.edge ? { edge: false as const } : {}) } : {}),
          ...(options.servicesDirectory ? { services: { directory: options.servicesDirectory } } : {}),
          ...(options.enrollmentEndpoint ? { enrollmentEndpoint: options.enrollmentEndpoint } : {}),
          ...(process.env.ZELAVIS_CLOUD_POLICY ? { cloud: { policyFile: resolve(process.env.ZELAVIS_CLOUD_POLICY),
            bundlePath: fileURLToPath(new URL("../../services/zelavis-cloud/bundle/index.js", import.meta.url)) } } : {}),
          projects: { previewHost: options.custody ? false : options.host,
            ...(process.env.ZELAVIS_AGENT_ENDPOINT ? { agentEndpoint: process.env.ZELAVIS_AGENT_ENDPOINT } : {}),
            // A Platform that accepts machines dispatches to them: enrolled nodes arrive through the registry.
            ...(remoteDispatch ? { remoteDispatch } : options.enrollmentEndpoint ? { remoteDispatch: { localNodeId: "local", nodes: {} } } : {}),
          },
      });
      const ownedAdapter = defineAdapter({ name: adapter.name,
        close: () => present(integration(() => adapter.close?.())),
        resolve: input => present(Effect.gen(function* () {
          const resolved = yield* integration(() => adapter.resolve!(input));
          resources = resolved.resources;
          if (configuration.handover === true && options.custody && resources?.systemStore) incomingContinuity = (yield* integration(() => resources!.systemStore!.list("projects")))
            .map(record => record.value as unknown as ZelavisProjectRecord).filter(project => project.runtime?.status === "running");
          if (resources?.systemStore && options.custody) {
            const authority = options.custody;
            previews = createZelavisEdgePreviews({ store: resources.systemStore, host: {
              open: ({ projectId, port, fetch }) => present(Effect.gen(function* () {
                const result = yield* requestNodeRuntimeControl(authority.endpoint, { action: "preview-open", projectId, port }, authority.token);
                yield* evaluate(() => { if (!Number.isInteger(result.port) || Number(result.port) < 1024 || Number(result.port) > 65535) throw new Error("Persistent preview host returned an invalid port."); });
                previewFetch.set(projectId, fetch);
                return { port: Number(result.port), close: () => present(Effect.gen(function* () {
                  previewFetch.delete(projectId);
                  yield* requestNodeRuntimeControl(authority.endpoint, { action: "preview-close", projectId }, authority.token);
                })) };
              })),
            } });
          }
          return { ...resolved, resources: { ...resources,
            ...(resources?.projectRuntime ? { projectRuntime: wrap(resources.projectRuntime) } : {}),
            ...(resources?.deploymentBackends ? { deploymentBackends: resources.deploymentBackends.map(backend => ({ ...backend, ...(backend.projectRuntime ? { projectRuntime: wrap(backend.projectRuntime) } : {}) })) } : {}),
            ...(previews ? { edgePreviews: previews } : {}),
          } };
        })),
      });
      const zv = new Zelavis({ ...(frontend ? { frontend } : {}), adapter: ownedAdapter,
        onError: ({ error }) => ({ status: 400, body: { error: error instanceof Error ? error.message : "Unknown error" } }),
      });
      const runtime = yield* integration(() => zv.runtime()).pipe(Effect.onError(() => integration(() => zv.close()).pipe(Effect.ignore)));
      yield* Effect.gen(function* () {
        if (options.installation?.edge) {
          yield* evaluate(() => { if (!resources?.edge || !resources.edgeRoutes) throw new Error("Production ingress requires the installation's Edge manager and host operation Agent."); });
          // The installer-owned descriptor selects the persistent listener's
          // port independently of the replaceable engine worker.
          const descriptor = yield* integration(() => readFile(resolve(options.installation!.prefix, "runtime.json"), "utf8"));
          const port = yield* evaluate(() => {
            const value = JSON.parse(descriptor);
            if (value.prefix !== options.installation!.prefix || value.instance !== options.installation!.instance || value.dataDirectory !== options.dataDirectory || value.edge !== true) throw new Error("Production ingress disagrees with installer-selected runtime paths.");
            return Number(value.port);
          });
          yield* ensureProductionEdge({ manager: resources!.edge!, routes: resources!.edgeRoutes!, port });
        }
        if (previews) yield* effectOperations(previews, ["configure"]).restore();
      }).pipe(
        Effect.onError(() => integration(() => zv.close()).pipe(Effect.ignore)),
      );
      const qualify = Effect.gen(function* () {
        // Ordinary startup restores desired-running Projects asynchronously.
        // Only an engine transfer must prove continuity before readiness.
        if (initialProbe) {
          initialProbe = false;
          if (configuration.handover !== true) return;
        }
        if (!options.custody || !resources?.systemStore || !resources.projectRuntime) return;
        const records = yield* integration(() => resources!.systemStore!.list("projects"));
        const current = records.map(record => record.value as unknown as ZelavisProjectRecord).filter(project => project.runtime?.status === "running");
        const projects = new Map([...incomingContinuity, ...current].map(project => [project.id, project]));
        yield* Effect.forEach([...projects.values()], project => Effect.gen(function* () {
          const driver = project.runtimeKind === "native" ? resources!.projectRuntime
            : resources!.deploymentBackends?.find(backend => backend.id === project.runtimeKind)?.projectRuntime;
          if (!driver) return yield* evaluate(() => { throw new Error(`Project ${project.id} has no driver for its locked backend ${project.runtimeKind}.`); });
          yield* evaluate(() => {
            if (!driver.capabilities(project).survivesControlPlaneRestart) throw new Error(`Project ${project.id} has no qualified Agent custody for a Platform handover.`);
          });
          const state = yield* effectOperations(driver, ["capabilities", "supportsLiveUpdate"]).status(project.id);
          yield* evaluate(() => { if (state.status !== "running" || state.url !== project.runtime.url) throw new Error(`Project ${project.id} was not adopted at its stable address: ${state.error ?? state.status}.`); });
        }), { concurrency: 4, discard: true });
        incomingContinuity = [];
      });
      return { runtime: { fetch: (request, context) => {
        const projectId = request.headers.get(NODE_RUNTIME_PREVIEW_ID);
        if (!projectId) return runtime.fetch(request, context);
        if (!options.custody || request.headers.get(NODE_RUNTIME_PREVIEW_KEY) !== options.custody.token) return Promise.resolve(new Response("Private preview authority required.", { status: 401 }));
        const headers = new Headers(request.headers); headers.delete(NODE_RUNTIME_PREVIEW_ID); headers.delete(NODE_RUNTIME_PREVIEW_KEY);
        return previewFetch.get(projectId)?.(new Request(request, { headers })) ?? Promise.resolve(new Response("Preview unavailable.", { status: 503 }));
      } }, qualify, close: reason => Effect.gen(function* () {
        preserve = Boolean(options.custody) && (reason !== "shutdown" || options.custody!.preserveOnShutdown);
        yield* integration(() => zv.close());
      }) };
    }),
  };
});
