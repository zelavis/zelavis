import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "fabric.app-data-placement.v1";
const MAX_ID_LENGTH = 256;

/** Project deletion participant; idempotent after a stopped runtime. */
export function deleteAppShardPlacementReservations(
  store: ZelavisSystemStore,
  projectId: string,
): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
  if (!validId(projectId)) throw new TypeError("Invalid Project id for shard placement cleanup");
  (yield* integrationValue(store.delete(NAMESPACE, projectId)));
}));
  }

export interface AppShardPlacementRequest {
  readonly protocolVersion: 1;
  readonly operationId: string;
  readonly projectId: string;
  readonly shardId: string;
  readonly virtualRanges: readonly number[];
  readonly mapVersion: number;
  /** Zero means that no placement record has yet been observed. */
  readonly expectedRevision: number;
  readonly resources: {
    readonly cpuCores: number;
    readonly memoryBytes: number;
    readonly diskBytes: number;
  };
}

export interface AppShardAllocation {
  readonly projectId: string;
  readonly generation: number;
  readonly allowedNodeIds: readonly string[];
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

export interface AppShardPlacementNode {
  readonly id: string;
  readonly ready: boolean;
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

/** A reservation has no writer authority and is never a routable target. */
export interface AppShardPlacementReservation {
  readonly protocolVersion: 1;
  readonly state: "reserved";
  readonly operationId: string;
  readonly projectId: string;
  readonly shardId: string;
  readonly nodeId: string;
  readonly allocationGeneration: number;
  readonly mapVersion: number;
  readonly virtualRanges: readonly number[];
  readonly resources: AppShardPlacementRequest["resources"];
  readonly revision: number;
  readonly requestFingerprint: string;
}

export type AppShardPlacementRefusal =
  | "invalid-request"
  | "foreign-project"
  | "allocation-unavailable"
  | "allocation-changed"
  | "out-of-envelope"
  | "no-eligible-node"
  | "range-conflict"
  | "revision-conflict"
  | "operation-conflict";

export type AppShardPlacementDecision =
  | { readonly granted: true; readonly reservation: AppShardPlacementReservation }
  | { readonly granted: false; readonly reason: AppShardPlacementRefusal; readonly currentRevision: number };

export interface AppShardPlacementAuthority {
  /** Caller identity comes from the authenticated Project channel, not request data. */
  readonly request: (callerProjectId: string, input: unknown) => Promise<AppShardPlacementDecision>;
  readonly current: (projectId: string, shardId: string) => Promise<AppShardPlacementReservation | undefined>;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
  !/[\u0000-\u001f]/.test(value);
const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => nonnegativeInteger(value) && value > 0;

function validRequest(value: unknown): value is AppShardPlacementRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AppShardPlacementRequest>;
  const resources = request.resources;
  const allowed = new Set(["protocolVersion", "operationId", "projectId", "shardId", "virtualRanges", "mapVersion", "expectedRevision", "resources"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) ||
      !resources || typeof resources !== "object" || Array.isArray(resources) ||
      Object.keys(resources).some((key) => !["cpuCores", "memoryBytes", "diskBytes"].includes(key))) return false;
  return request.protocolVersion === 1 &&
    validId(request.operationId) && validId(request.projectId) && validId(request.shardId) &&
    positiveInteger(request.mapVersion) && nonnegativeInteger(request.expectedRevision) &&
    Array.isArray(request.virtualRanges) && request.virtualRanges.length > 0 &&
    request.virtualRanges.length <= 4096 &&
    request.virtualRanges.every(nonnegativeInteger) &&
    new Set(request.virtualRanges).size === request.virtualRanges.length &&
    resources !== undefined && positiveInteger(resources.cpuCores) &&
    positiveInteger(resources.memoryBytes) && positiveInteger(resources.diskBytes);
}

function decode(value: ZelavisSystemStoreValue): AppShardPlacementReservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reservation = value as unknown as AppShardPlacementReservation;
  if (reservation.protocolVersion !== 1 || reservation.state !== "reserved" ||
      !validId(reservation.projectId) || !validId(reservation.shardId) ||
      !positiveInteger(reservation.revision)) return undefined;
  return reservation;
}

interface ReservationLedger {
  readonly protocolVersion: 1;
  readonly revision: number;
  readonly reservations: readonly AppShardPlacementReservation[];
  readonly usedOperationIds: readonly string[];
}

function decodeLedger(value: ZelavisSystemStoreValue, projectId: string): ReservationLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid App shard placement ledger");
  }
  const ledger = value as unknown as ReservationLedger;
  if (ledger.protocolVersion !== 1 || !positiveInteger(ledger.revision) ||
      !Array.isArray(ledger.reservations) ||
      !Array.isArray(ledger.usedOperationIds) ||
      ledger.usedOperationIds.some((id) => !validId(id)) ||
      new Set(ledger.usedOperationIds).size !== ledger.usedOperationIds.length ||
      ledger.reservations.some((reservation) => !decode(reservation as unknown as ZelavisSystemStoreValue)) ||
      ledger.reservations.some((reservation) => reservation.projectId !== projectId) ||
      ledger.reservations.some((reservation) => !ledger.usedOperationIds.includes(reservation.operationId)) ||
      new Set(ledger.reservations.map((entry) => entry.shardId)).size !== ledger.reservations.length ||
      new Set(ledger.reservations.map((entry) => entry.operationId)).size !== ledger.reservations.length) {
    throw new Error("Invalid App shard placement ledger");
  }
  return ledger;
}

function fingerprint(request: AppShardPlacementRequest): string {
  return JSON.stringify({
    protocolVersion: request.protocolVersion,
    operationId: request.operationId,
    projectId: request.projectId,
    shardId: request.shardId,
    virtualRanges: [...request.virtualRanges].sort((a, b) => a - b),
    mapVersion: request.mapVersion,
    expectedRevision: request.expectedRevision,
    resources: request.resources,
  });
}

/**
 * Platform-only admission boundary for future remote App shard placement.
 * It persists a conditional reservation. Activation, writer epochs, Agent
 * dispatch and publication require separate authority and are not provided.
 */
export function createAppShardPlacementAuthority(options: {
  readonly store: ZelavisSystemStore;
  readonly allocation: (projectId: string) => Promise<AppShardAllocation | undefined> | AppShardAllocation | undefined;
  readonly nodes: () => Promise<readonly AppShardPlacementNode[]> | readonly AppShardPlacementNode[];
}): AppShardPlacementAuthority {
  // One CAS record per Project keeps aggregate reservation accounting atomic.
  const keyFor = (projectId: string) => projectId;
  const current = (projectId: string, shardId: string) => present(Effect.gen(function* () {
    if (!validId(projectId) || !validId(shardId)) return undefined;
    const record = (yield* integrationValue(options.store.get(NAMESPACE, keyFor(projectId))));
    return record ? decodeLedger(record.value, projectId).reservations.find((entry) => entry.shardId === shardId) : undefined;
  }));

  return {
    current,
    request(callerProjectId, input) {
    return present(Effect.gen(function* () {
      const refuse = (reason: AppShardPlacementRefusal, currentRevision = 0): AppShardPlacementDecision =>
        ({ granted: false, reason, currentRevision });
      let request: unknown;
      try {
        request = structuredClone(input);
      } catch {
        return (yield* integrationValue(refuse("invalid-request")));
      }
      if (!validId(callerProjectId) || !validRequest(request)) return (yield* integrationValue(refuse("invalid-request")));
      if (callerProjectId !== request.projectId) return (yield* integrationValue(refuse("foreign-project")));
      const allocation = (yield* integrationValue(options.allocation(callerProjectId)));
      if (!allocation || allocation.projectId !== callerProjectId ||
          !positiveInteger(allocation.generation)) return (yield* integrationValue(refuse("allocation-unavailable")));
      const key = keyFor(request.projectId);
      const existing = (yield* integrationValue(options.store.get(NAMESPACE, key)));
      const ledger = existing ? decodeLedger(existing.value, request.projectId) : undefined;
      const revision = ledger?.revision ?? 0;
      const previous = ledger?.reservations.find((entry) => entry.shardId === request.shardId);
      const requestFingerprint = fingerprint(request);
      if (previous?.operationId === request.operationId) {
        if (previous.requestFingerprint !== requestFingerprint) return (yield* integrationValue(refuse("operation-conflict", revision)));
        if (previous.allocationGeneration !== allocation.generation) return (yield* integrationValue(refuse("allocation-changed", revision)));
        return { granted: true, reservation: previous };
      }
      if (ledger?.usedOperationIds.includes(request.operationId)) return (yield* integrationValue(refuse("operation-conflict", revision)));
      if (request.expectedRevision !== revision) return (yield* integrationValue(refuse("revision-conflict", revision)));
      const others = ledger?.reservations.filter((entry) => entry.shardId !== request.shardId) ?? [];
      const occupiedRanges = new Set(others.flatMap((entry) => entry.virtualRanges));
      if (request.virtualRanges.some((range) => occupiedRanges.has(range))) return (yield* integrationValue(refuse("range-conflict", revision)));
      if (request.resources.cpuCores + others.reduce((sum, entry) => sum + entry.resources.cpuCores, 0) > allocation.cpuCores ||
          request.resources.memoryBytes + others.reduce((sum, entry) => sum + entry.resources.memoryBytes, 0) > allocation.memoryBytes ||
          request.resources.diskBytes + others.reduce((sum, entry) => sum + entry.resources.diskBytes, 0) > allocation.diskBytes) return (yield* integrationValue(refuse("out-of-envelope", revision)));
      const eligible = ((yield* integrationValue(options.nodes()))).filter((node) =>
        node.ready && allocation.allowedNodeIds.includes(node.id) &&
        node.cpuCores >= request.resources.cpuCores &&
        node.memoryBytes >= request.resources.memoryBytes &&
        node.diskBytes >= request.resources.diskBytes,
      ).sort((a, b) => a.id.localeCompare(b.id));
      const node = eligible[0];
      if (!node) return (yield* integrationValue(refuse("no-eligible-node", revision)));
      const reservation: AppShardPlacementReservation = {
        protocolVersion: 1,
        state: "reserved",
        operationId: request.operationId,
        projectId: request.projectId,
        shardId: request.shardId,
        nodeId: node.id,
        allocationGeneration: allocation.generation,
        mapVersion: request.mapVersion,
        virtualRanges: [...request.virtualRanges].sort((a, b) => a - b),
        resources: request.resources,
        revision: revision + 1,
        requestFingerprint,
      };
      const next: ReservationLedger = {
        protocolVersion: 1,
        revision: revision + 1,
        reservations: [...others, reservation].sort((a, b) => a.shardId.localeCompare(b.shardId)),
        usedOperationIds: [...(ledger?.usedOperationIds ?? []), request.operationId],
      };
      const value = next as unknown as ZelavisSystemStoreValue;
      const written = existing
        ? (yield* integrationValue(options.store.compareAndSet(NAMESPACE, key, existing.updatedAt, value, existing.value)))
        : ((yield* integrationValue(options.store.setIfAbsent(NAMESPACE, key, value)))).created;
      if (!written) {
        const latestRecord = (yield* integrationValue(options.store.get(NAMESPACE, key)));
        const latestLedger = latestRecord ? decodeLedger(latestRecord.value, request.projectId) : undefined;
        const latest = latestLedger?.reservations.find((entry) => entry.shardId === request.shardId);
        if (latest?.operationId === request.operationId &&
            latest.requestFingerprint === requestFingerprint &&
            latest.allocationGeneration === allocation.generation) {
          return { granted: true, reservation: latest };
        }
        return (yield* integrationValue(refuse("revision-conflict", latestLedger?.revision ?? 0)));
      }
      return { granted: true, reservation };
    }));
  },
  };
}
