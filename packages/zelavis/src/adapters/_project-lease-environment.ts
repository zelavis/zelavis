import { Effect } from "effect";
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
 * - optional `ZELAVIS_PROJECT_LEASES_TTL_MILLIS` (default 30000: a renewal per Project every ten seconds) and
 *   `ZELAVIS_PROJECT_LEASES_ENDPOINT` (where followers read this node's Projects).
 *
 * All of the first three or none; a partial configuration is refused at start, never run unguarded.
 */
export interface ProjectLeaseConfiguration {
  readonly authority: string;
  readonly node: string;
  readonly standby: string;
  readonly ttlMillis: number;
  readonly endpoint?: string;
}

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
  const endpoint = environment.ZELAVIS_PROJECT_LEASES_ENDPOINT?.trim();
  return { authority, node, standby, ttlMillis, ...(endpoint ? { endpoint } : {}) };
};

/** What a starting Project is given: `leaseFromEnvironment` reads exactly this. The token opens this Project's lease for this node only. */
export const projectLeaseEnvironment = (configuration: ProjectLeaseConfiguration, store: ZelavisSystemStore, projectId: string): Promise<Readonly<Record<string, string>>> =>
  present(Effect.gen(function* () {
    const secret = yield* integration(() => loadPlatformMasterSecret(store));
    const token = yield* integration(() => mintLeaseCapability(secret, { scope: projectId, node: configuration.node }));
    return {
      ZELAVIS_LEASE_AUTHORITY: configuration.authority,
      ZELAVIS_LEASE_TOKEN: token,
      ZELAVIS_LEASE_NODE: configuration.node,
      ZELAVIS_LEASE_STANDBY: configuration.standby,
      ZELAVIS_LEASE_TTL_MILLIS: String(configuration.ttlMillis),
      ...(configuration.endpoint === undefined ? {} : { ZELAVIS_LEASE_ENDPOINT: configuration.endpoint }),
    };
  }));
