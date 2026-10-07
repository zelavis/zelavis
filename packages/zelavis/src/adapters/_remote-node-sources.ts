import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect } from "effect";
import { IntegrationFailure, integration } from "../core/runtime/effect-boundary.js";
import type { FabricNode } from "../core/fabric/index.js";
import type { NodeEnrollmentAuthority } from "../platform/node-enrollment.js";
import { probeProjectAgent, type Destination } from "./_project-dispatch-https.js";

/** Probes run a handful at a time, so a large fleet cannot flood the Platform. */
const PROBE_CONCURRENCY = 8;

export interface RemoteNodeSourcesOptions {
  /** This host's own Fabric node id. A remote node can never take it over. */
  readonly localNodeId: string;
  /** Operator-configured nodes: a CA file pinned at startup. They win over the registry. */
  readonly staticNodes: Readonly<Record<string, { readonly url: string; readonly agentId: string; readonly caFile: string }>>;
  /** Nodes that enrolled at runtime. */
  readonly registry?: NodeEnrollmentAuthority;
}

export interface RemoteNodeSources {
  /** Static destinations, with their CA read from disk. */
  readonly destinations: Readonly<Record<string, Destination>>;
  /** Registry lookup for a node that is not configured; absent without a registry. */
  readonly resolveDestination?: (nodeId: string) => Effect.Effect<Destination | undefined, IntegrationFailure>;
  /** Static and registered remote nodes, each probed. Revoked nodes are not listed. */
  readonly inventoryNodes: () => Effect.Effect<readonly FabricNode[], IntegrationFailure>;
}

const readyNode = (nodeId: string, ready: boolean): FabricNode => ({
  id: nodeId,
  status: ready ? "ready" : "unavailable",
  roles: ["worker"],
  runtimeEngine: "node",
  runtimeDriver: "local-project",
});

/**
 * Where this Platform can send Projects: the nodes an operator configured, plus
 * the ones that enrolled. A configured node always wins over a registered one
 * of the same id, and the local node id is never reachable through the registry.
 */
export const loadRemoteNodeSources = Effect.fn("RemoteNodeSources.load")(function* (options: RemoteNodeSourcesOptions) {
  if (!options.localNodeId || options.staticNodes[options.localNodeId]) {
    return yield* Effect.fail(new IntegrationFailure(new Error("Remote dispatch needs a distinct local Fabric Node id.")));
  }
  const loaded = yield* Effect.forEach(
    Object.entries(options.staticNodes),
    ([nodeId, node]) =>
      integration(() => readFile(resolve(node.caFile), "utf8")).pipe(
        Effect.map((caPem) => [nodeId, { url: node.url, agentId: node.agentId, caPem }] as const),
      ),
    { concurrency: PROBE_CONCURRENCY },
  );
  const destinations: Readonly<Record<string, Destination>> = Object.fromEntries(loaded);
  const { registry, localNodeId } = options;

  const resolveDestination = registry === undefined
    ? undefined
    : (nodeId: string) =>
        nodeId === localNodeId
          ? Effect.succeed(undefined)
          : registry.destination(nodeId).pipe(Effect.mapError((error) => new IntegrationFailure(error)));

  const inventoryNodes = Effect.fn("RemoteNodeSources.inventoryNodes")(function* () {
    const registered = registry === undefined
      ? {}
      : yield* registry.destinations().pipe(Effect.mapError((error) => new IntegrationFailure(error)));
    const targets: [string, Destination][] = [
      ...Object.entries(destinations),
      ...Object.entries(registered).filter(([nodeId]) => destinations[nodeId] === undefined && nodeId !== localNodeId),
    ];
    return yield* Effect.forEach(
      targets,
      ([nodeId, target]) =>
        integration(() => probeProjectAgent(target, nodeId)).pipe(Effect.map((ready) => readyNode(nodeId, ready))),
      { concurrency: PROBE_CONCURRENCY },
    );
  });

  return { destinations, ...(resolveDestination ? { resolveDestination } : {}), inventoryNodes } satisfies RemoteNodeSources;
});
