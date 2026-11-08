import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import type { AppShardPlacement } from "./app-data-placement.js";

export const APP_SHARD_ALLOCATION_NAMESPACE = "fabric.app-data-allocation.v1";
const MAX_ID_LENGTH = 256;
const MAX_ALLOWED_NODES = 64;

/** The Nodes a Project's remote shards may use and the budget they share; absent means remote shards are off. */
export interface AppShardAllocationRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  /** 1 on the first set, +1 on each. */
  readonly generation: number;
  readonly allowedNodeIds: readonly string[];
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
}

export interface AppShardAllocationInput {
  readonly allowedNodeIds: readonly string[];
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  /** Zero when no allocation has been observed. */
  readonly expectedGeneration: number;
}

export type AppShardAllocationResult =
  | { readonly ok: true; readonly allocation: AppShardAllocationRecord }
  | {
    readonly ok: false;
    readonly reason: "invalid-request" | "generation-conflict" | "allocation-in-use";
    readonly current?: AppShardAllocationRecord;
    readonly inUse?: readonly string[];
  };

export interface AppShardAllocationStore {
  readonly get: (projectId: string) => Promise<AppShardAllocationRecord | undefined>;
  /** `live` lists the Project's live placements, read in the same call, to refuse shrinking under them. */
  readonly set: (
    projectId: string,
    input: unknown,
    live: () => Promise<readonly AppShardPlacement[]>,
  ) => Promise<AppShardAllocationResult>;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
  !/[\u0000-\u001f]/.test(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validInput(value: unknown): value is AppShardAllocationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<AppShardAllocationInput>;
  const allowed = new Set(["allowedNodeIds", "cpuCores", "memoryBytes", "diskBytes", "expectedGeneration"]);
  return Object.keys(input).every((key) => allowed.has(key)) &&
    Array.isArray(input.allowedNodeIds) && input.allowedNodeIds.length > 0 &&
    input.allowedNodeIds.length <= MAX_ALLOWED_NODES && input.allowedNodeIds.every(validId) &&
    new Set(input.allowedNodeIds).size === input.allowedNodeIds.length &&
    positiveInteger(input.cpuCores) && positiveInteger(input.memoryBytes) && positiveInteger(input.diskBytes) &&
    typeof input.expectedGeneration === "number" && Number.isSafeInteger(input.expectedGeneration) &&
    input.expectedGeneration >= 0;
}

function decode(value: ZelavisSystemStoreValue, projectId: string): AppShardAllocationRecord {
  const record = value as unknown as AppShardAllocationRecord;
  if (!value || typeof value !== "object" || Array.isArray(value) || record.schemaVersion !== 1 ||
      record.projectId !== projectId || !positiveInteger(record.generation) ||
      !Array.isArray(record.allowedNodeIds) || !record.allowedNodeIds.every(validId) ||
      !positiveInteger(record.cpuCores) || !positiveInteger(record.memoryBytes) || !positiveInteger(record.diskBytes)) {
    throw new Error("Invalid App shard allocation record");
  }
  return record;
}

export function createAppShardAllocationStore(store: ZelavisSystemStore): AppShardAllocationStore {
  const read = (projectId: string) => present(Effect.gen(function* () {
    const stored = (yield* integrationValue(store.get(APP_SHARD_ALLOCATION_NAMESPACE, projectId)));
    return { stored, record: stored ? decode(stored.value, projectId) : undefined };
  }));
  return {
    get: (projectId) => present(Effect.gen(function* () {
      if (!validId(projectId)) return undefined;
      return (yield* integrationValue(read(projectId))).record;
    })),
    set: (projectId, input, live) => present(Effect.gen(function* (): Effect.fn.Return<AppShardAllocationResult, IntegrationFailure> {
      if (!validId(projectId) || !validInput(input)) return { ok: false, reason: "invalid-request" };
      const { stored, record } = (yield* integrationValue(read(projectId)));
      if (input.expectedGeneration !== (record?.generation ?? 0)) {
        return { ok: false, reason: "generation-conflict", ...(record ? { current: record } : {}) };
      }
      // A placement admitted between this read and the write is still bounded: `request` re-reads the allocation it
      // is admitted under and records that generation.
      const placements = (yield* integrationValue(live())).filter((placement) => placement.state !== "released");
      const sum = (pick: (placement: AppShardPlacement) => number) => placements.reduce((total, placement) => total + pick(placement), 0);
      const inUse = placements.filter((placement) => !input.allowedNodeIds.includes(placement.nodeId)).map((placement) => placement.shardId);
      if (inUse.length > 0 || sum((p) => p.resources.cpuCores) > input.cpuCores ||
          sum((p) => p.resources.memoryBytes) > input.memoryBytes || sum((p) => p.resources.diskBytes) > input.diskBytes) {
        return { ok: false, reason: "allocation-in-use", inUse: inUse.length > 0 ? inUse : placements.map((placement) => placement.shardId) };
      }
      const next: AppShardAllocationRecord = {
        schemaVersion: 1,
        projectId,
        generation: (record?.generation ?? 0) + 1,
        allowedNodeIds: [...input.allowedNodeIds],
        cpuCores: input.cpuCores,
        memoryBytes: input.memoryBytes,
        diskBytes: input.diskBytes,
      };
      const value = next as unknown as ZelavisSystemStoreValue;
      const written = stored
        ? (yield* integrationValue(store.compareAndSet(APP_SHARD_ALLOCATION_NAMESPACE, projectId, stored.updatedAt, value, stored.value)))
        : ((yield* integrationValue(store.setIfAbsent(APP_SHARD_ALLOCATION_NAMESPACE, projectId, value)))).created;
      if (written) return { ok: true, allocation: next };
      const latest = (yield* integrationValue(read(projectId))).record;
      return { ok: false, reason: "generation-conflict", ...(latest ? { current: latest } : {}) };
    })),
  };
}

/** Project deletion participant; idempotent. */
export function deleteAppShardAllocation(store: ZelavisSystemStore, projectId: string): Promise<void> {
  return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    if (!validId(projectId)) throw new TypeError("Invalid Project id for shard allocation cleanup");
    (yield* integrationValue(store.delete(APP_SHARD_ALLOCATION_NAMESPACE, projectId)));
  }));
}
