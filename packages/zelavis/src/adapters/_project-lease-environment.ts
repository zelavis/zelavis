import * as Effect from "effect/Effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { mintLeaseCapability } from "../platform/lease-capability.js";
import { loadPlatformMasterSecret } from "../platform/master-secret.js";
import type { ZelavisSystemStore } from "../system-store.js";

/**
 * Lease-guarding the Projects this Platform starts. Off unless the operator configures it, because a lease needs somewhere
 * to be kept that a standby can reach and a node to name as the standby; with one node and no standby there is nothing for
 * a lease to protect.
 *
 * - `ZELAVIS_PROJECT_LEASES_URL`: the Platform's API root as a Project process reaches it (`http://127.0.0.1:3000/zelavis/api/v1`
 *   for Projects on the Platform's own host).
 * - `ZELAVIS_PROJECT_LEASES_NODE`: this node's id, the owner a Project's lease names.
 * - `ZELAVIS_PROJECT_LEASES_STANDBY`: the node a Project's writes wait for, the only one promoted without accepting loss.
 * - optional `ZELAVIS_PROJECT_LEASES_TTL_MILLIS` (default 30000: a renewal per Project every ten seconds).
 *
 * Where followers read a Project's writer is not configured: it is the Platform itself (the API root without `/api/v1`),
 * which routes a follower to wherever the Project is placed now, so the one endpoint is right at every epoch.
 *
 * All of the first three or none; a partial configuration is refused at start, never run unguarded.
 */
export interface ProjectLeaseConfiguration {
  readonly authority: string;
  readonly node: string;
  readonly standby: string;
  readonly ttlMillis: number;
}

/** Which of a Project's two processes is being started: the one that writes, or the one that follows it and takes over. */
export type ProjectLeaseRole = "writer" | "standby";

export const projectLeaseConfiguration = (environment: Readonly<Record<string, string | undefined>> = process.env): ProjectLeaseConfiguration | undefined => {
  const authority = environment.ZELAVIS_PROJECT_LEASES_URL?.trim();
  const node = environment.ZELAVIS_PROJECT_LEASES_NODE?.trim();
  const standby = environment.ZELAVIS_PROJECT_LEASES_STANDBY?.trim();
  if (!authority && !node && !standby) return undefined;
  if (!authority || !node || !standby) {
    throw new Error("Lease-guarded Projects need ZELAVIS_PROJECT_LEASES_URL, ZELAVIS_PROJECT_LEASES_NODE and ZELAVIS_PROJECT_LEASES_STANDBY together.");
  }
  const ttlMillis = Number(environment.ZELAVIS_PROJECT_LEASES_TTL_MILLIS ?? 30_000);
  if (!Number.isSafeInteger(ttlMillis) || ttlMillis < 1000) throw new Error("ZELAVIS_PROJECT_LEASES_TTL_MILLIS is at least 1000.");
  if (!/\/api\/v1\/?$/.test(authority)) throw new Error("ZELAVIS_PROJECT_LEASES_URL is the Platform's API root, ending in /api/v1.");
  return { authority, node, standby, ttlMillis };
};

/** What a starting Project is given: `leaseFromEnvironment` reads exactly this. The token opens this Project's lease for this node only. */
export const projectLeaseEnvironment = (configuration: ProjectLeaseConfiguration, store: ZelavisSystemStore, projectId: string, role: ProjectLeaseRole): Promise<Readonly<Record<string, string>>> =>
  projectLeaseEnvironmentAt(configuration, store, projectId, role === "writer" ? configuration.node : configuration.standby, role);

/**
 * The environment of a Project process that runs on `node`, which is either of the two the Platform names. The other is its
 * successor: the node it hands back to when it is the writer, and the one whose writes it waits for. A writer that is the
 * standby node after a failover is the same environment a standby has, with the role `writer`.
 */
export const projectLeaseEnvironmentAt = (configuration: ProjectLeaseConfiguration, store: ZelavisSystemStore, projectId: string, node: string, role: ProjectLeaseRole): Promise<Readonly<Record<string, string>>> =>
  present(Effect.gen(function* () {
    if (node !== configuration.node && node !== configuration.standby) throw new Error(`Node "${node}" is neither of the nodes this Platform lease-guards Projects between.`);
    const successor = node === configuration.node ? configuration.standby : configuration.node;
    const secret = yield* integration(() => loadPlatformMasterSecret(store));
    const token = yield* integration(() => mintLeaseCapability(secret, { scope: projectId, node }));
    return {
      ZELAVIS_LEASE_AUTHORITY: configuration.authority,
      ZELAVIS_LEASE_TOKEN: token,
      ZELAVIS_LEASE_NODE: node,
      ZELAVIS_LEASE_STANDBY: successor,
      ZELAVIS_LEASE_ROLE: role,
      ZELAVIS_LEASE_TTL_MILLIS: String(configuration.ttlMillis),
      ZELAVIS_LEASE_ENDPOINT: configuration.authority.replace(/\/api\/v1\/?$/, ""),
    };
  }));

const PROJECT_LEASE_VARIABLES = Object.freeze([
  "ZELAVIS_LEASE_AUTHORITY", "ZELAVIS_LEASE_TOKEN", "ZELAVIS_LEASE_NODE", "ZELAVIS_LEASE_STANDBY", "ZELAVIS_LEASE_ROLE", "ZELAVIS_LEASE_TTL_MILLIS", "ZELAVIS_LEASE_ENDPOINT",
]);

/**
 * The lease variables a Project's host process was started with, for the engine process it starts in turn: the host
 * hands its engine an allow-listed environment, and without these the engine would open its database unguarded.
 */
export const inheritedProjectLeaseEnvironment = (environment: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<string, string>> =>
  Object.fromEntries(PROJECT_LEASE_VARIABLES.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]!]]));
