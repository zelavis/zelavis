import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "fabric.project-ownership.v1";
const MAX_LEASE_MS = 15 * 60_000;

export interface ProjectPlacementRecord {
  readonly schemaVersion: 1;
  readonly authority: "platform";
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  /** Strictly increases on every activation, including same-Node takeover. */
  readonly epoch: number;
  readonly revision: number;
  readonly leaseExpiresAt: number;
  readonly state: "active" | "released";
}

export interface ProjectPlacementToken {
  readonly projectId: string;
  readonly nodeId: string;
  readonly ownerSession: string;
  readonly epoch: number;
}

export type ProjectPlacementResult =
  | { readonly granted: true; readonly placement: ProjectPlacementRecord }
  | {
      readonly granted: false;
      readonly reason: "invalid-request" | "policy-refused" | "owned" | "fencing-unavailable" | "stale" | "expired" | "contended";
      readonly current?: ProjectPlacementRecord;
    };

export interface ProjectPlacementAuthority {
  current(projectId: string): Promise<ProjectPlacementRecord | undefined>;
  acquire(input: {
    readonly projectId: string;
    readonly nodeId: string;
    readonly ownerSession: string;
    readonly expectedEpoch: number;
    readonly leaseMs: number;
  }): Promise<ProjectPlacementResult>;
  renew(token: ProjectPlacementToken, leaseMs: number): Promise<ProjectPlacementResult>;
  release(token: ProjectPlacementToken): Promise<ProjectPlacementResult>;
  validate(token: ProjectPlacementToken): Promise<boolean>;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);
const validEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validLease = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_LEASE_MS;

function decode(value: ZelavisSystemStoreValue, projectId: string): ProjectPlacementRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed Project placement authority record");
  }
  const record = value as unknown as ProjectPlacementRecord;
  if (record.schemaVersion !== 1 || record.authority !== "platform" ||
      record.projectId !== projectId || !validId(record.nodeId) ||
      !validId(record.ownerSession) || !validEpoch(record.epoch) ||
      record.epoch === 0 || !validEpoch(record.revision) || record.revision === 0 ||
      !Number.isSafeInteger(record.leaseExpiresAt) ||
      (record.state !== "active" && record.state !== "released")) {
    throw new Error("Malformed Project placement authority record");
  }
  return record;
}

const matches = (record: ProjectPlacementRecord, token: ProjectPlacementToken) =>
  record.projectId === token.projectId && record.nodeId === token.nodeId &&
  record.ownerSession === token.ownerSession && record.epoch === token.epoch;

/**
 * System Store CAS is the single writer of Project placement ownership.
 * A plan or route URL grants nothing; only an active unexpired record does.
 */
export function createProjectPlacementAuthority(options: {
  readonly store: ZelavisSystemStore;
  readonly mayPlace: (projectId: string, nodeId: string) => Promise<boolean> | boolean;
  /** Must prove the prior owner is stopped before an expired lease is taken over. */
  readonly fencePrevious?: (placement: ProjectPlacementRecord) => Promise<boolean> | boolean;
  readonly now?: () => number;
}): ProjectPlacementAuthority {
  const now = options.now ?? Date.now;
  const read = async (projectId: string) => {
    const record = await options.store.get(NAMESPACE, projectId);
    return record ? { stored: record, value: decode(record.value, projectId) } : undefined;
  };
  const refuse = (
    reason: Exclude<ProjectPlacementResult, { granted: true }>["reason"],
    current?: ProjectPlacementRecord,
  ): ProjectPlacementResult => ({ granted: false, reason, ...(current ? { current } : {}) });

  return {
    async current(projectId) {
      if (!validId(projectId)) return undefined;
      return (await read(projectId))?.value;
    },
    async acquire(input) {
      const request = structuredClone(input);
      if (!validId(request.projectId) || !validId(request.nodeId) ||
          !validId(request.ownerSession) || !validEpoch(request.expectedEpoch) ||
          !validLease(request.leaseMs)) return refuse("invalid-request");
      if (!(await options.mayPlace(request.projectId, request.nodeId))) return refuse("policy-refused");
      const observed = await read(request.projectId);
      const previous = observed?.value;
      if ((previous?.epoch ?? 0) !== request.expectedEpoch) return refuse("stale", previous);
      const instant = now();
      if (previous?.state === "active" && previous.leaseExpiresAt > instant) {
        return refuse("owned", previous);
      }
      if (previous?.state === "active" &&
          !(await options.fencePrevious?.(previous))) {
        return refuse("fencing-unavailable", previous);
      }
      if (!Number.isSafeInteger(instant) ||
          !Number.isSafeInteger(instant + request.leaseMs) ||
          (previous && previous.epoch >= Number.MAX_SAFE_INTEGER)) return refuse("invalid-request", previous);
      const placement: ProjectPlacementRecord = {
        schemaVersion: 1,
        authority: "platform",
        projectId: request.projectId,
        nodeId: request.nodeId,
        ownerSession: request.ownerSession,
        epoch: (previous?.epoch ?? 0) + 1,
        revision: (previous?.revision ?? 0) + 1,
        leaseExpiresAt: instant + request.leaseMs,
        state: "active",
      };
      const value = placement as unknown as ZelavisSystemStoreValue;
      const written = observed
        ? await options.store.compareAndSet(NAMESPACE, request.projectId, observed.stored.updatedAt, value, observed.stored.value)
        : (await options.store.setIfAbsent(NAMESPACE, request.projectId, value)).created;
      return written ? { granted: true, placement } : refuse("contended", (await read(request.projectId))?.value);
    },
    async renew(token, leaseMs) {
      const claim = structuredClone(token);
      if (!validId(claim.projectId) || !validId(claim.nodeId) ||
          !validId(claim.ownerSession) || !validEpoch(claim.epoch) ||
          !validLease(leaseMs)) return refuse("invalid-request");
      const observed = await read(claim.projectId);
      const previous = observed?.value;
      if (!observed || !previous || !matches(previous, claim) || previous.state !== "active") {
        return refuse("stale", previous);
      }
      const instant = now();
      if (previous.leaseExpiresAt <= instant) return refuse("expired", previous);
      if (!Number.isSafeInteger(instant) || !Number.isSafeInteger(instant + leaseMs)) {
        return refuse("invalid-request", previous);
      }
      const placement: ProjectPlacementRecord = {
        ...previous,
        revision: previous.revision + 1,
        leaseExpiresAt: Math.max(previous.leaseExpiresAt, instant + leaseMs),
      };
      const written = await options.store.compareAndSet(NAMESPACE, claim.projectId,
        observed.stored.updatedAt, placement as unknown as ZelavisSystemStoreValue, observed.stored.value);
      return written ? { granted: true, placement } : refuse("contended", (await read(claim.projectId))?.value);
    },
    async release(token) {
      const claim = structuredClone(token);
      if (!validId(claim.projectId) || !validId(claim.nodeId) ||
          !validId(claim.ownerSession) || !validEpoch(claim.epoch)) return refuse("invalid-request");
      const observed = await read(claim.projectId);
      const previous = observed?.value;
      if (!observed || !previous || !matches(previous, claim)) return refuse("stale", previous);
      if (previous.state === "released") return { granted: true, placement: previous };
      const placement: ProjectPlacementRecord = {
        ...previous, state: "released", revision: previous.revision + 1,
      };
      const written = await options.store.compareAndSet(NAMESPACE, claim.projectId,
        observed.stored.updatedAt, placement as unknown as ZelavisSystemStoreValue, observed.stored.value);
      return written ? { granted: true, placement } : refuse("contended", (await read(claim.projectId))?.value);
    },
    async validate(token) {
      if (!validId(token.projectId) || !validId(token.nodeId) ||
          !validId(token.ownerSession) || !validEpoch(token.epoch)) return false;
      const placement = (await read(token.projectId))?.value;
      return Boolean(placement && placement.state === "active" &&
        placement.leaseExpiresAt > now() && matches(placement, token));
    },
  };
}

/** Read-only Agent adapter for a local System Store sharing the host clock. */
export async function readLocalProjectPlacementLease(
  store: ZelavisSystemStore,
  projectId: string,
): Promise<(ProjectPlacementRecord & { readonly authorityNow: number }) | undefined> {
  if (!validId(projectId)) return undefined;
  const stored = await store.get(NAMESPACE, projectId);
  if (!stored) return undefined;
  return { ...decode(stored.value, projectId), authorityNow: Date.now() };
}

/** Deletion participant runs after the Project stops, before its data is removed. */
export async function deleteProjectPlacementAuthority(
  store: ZelavisSystemStore,
  projectId: string,
): Promise<void> {
  if (!validId(projectId)) throw new TypeError("Invalid Project id for placement cleanup");
  await store.delete(NAMESPACE, projectId);
}
