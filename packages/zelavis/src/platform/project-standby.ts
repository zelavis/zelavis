import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

const NAMESPACE = "fabric.project-standby.v1";

/**
 * Where a lease-guarded Project's standby runs, and how it is doing. The Platform's Project manager is the only writer.
 * The record routes nothing and fences nothing: placement routes, the writer lease fences. It is what the Platform needs to
 * stop the standby before the writer, and what an operator reads to see that a Project has one.
 */
export interface ProjectStandbyRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly nodeId: string;
  /** The writer's placement epoch when the standby was started, for the record. */
  readonly writerEpoch: number;
  readonly state: "dispatched" | "stopped" | "promoted" | "failed";
  readonly error?: string;
  readonly updatedAt: string;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
const STATES = new Set(["dispatched", "stopped", "promoted", "failed"]);

function decode(value: ZelavisSystemStoreValue, projectId: string): ProjectStandbyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Project standby record");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.projectId !== projectId || !validId(record.nodeId) ||
      typeof record.writerEpoch !== "number" || !Number.isSafeInteger(record.writerEpoch) || record.writerEpoch < 0 ||
      typeof record.state !== "string" || !STATES.has(record.state) ||
      (record.error !== undefined && (typeof record.error !== "string" || record.error.length > 2048)) ||
      typeof record.updatedAt !== "string") throw new Error("Malformed Project standby record");
  return record as unknown as ProjectStandbyRecord;
}

export interface ProjectStandbyStore {
  read(projectId: string): Promise<ProjectStandbyRecord | undefined>;
  /** Writes the Project's standby record: created, or replacing the record read, and refused when it changed meanwhile. */
  write(record: Omit<ProjectStandbyRecord, "schemaVersion" | "updatedAt">): Promise<ProjectStandbyRecord>;
}

export function createProjectStandbyStore(store: ZelavisSystemStore, now: () => string = () => new Date().toISOString()): ProjectStandbyStore {
  return {
    read: (projectId) => present(Effect.gen(function* (): Effect.fn.Return<ProjectStandbyRecord | undefined, IntegrationFailure> {
      if (!validId(projectId)) return undefined;
      const stored = yield* integrationValue(store.get(NAMESPACE, projectId));
      return stored === undefined ? undefined : decode(stored.value, projectId);
    })),
    write: (input) => present(Effect.gen(function* (): Effect.fn.Return<ProjectStandbyRecord, IntegrationFailure> {
      if (!validId(input.projectId) || !validId(input.nodeId)) throw new TypeError("Invalid Project standby record");
      const record: ProjectStandbyRecord = { schemaVersion: 1, ...input, updatedAt: now() };
      const value = record as unknown as ZelavisSystemStoreValue;
      const observed = yield* integrationValue(store.get(NAMESPACE, input.projectId));
      const written = observed === undefined
        ? (yield* integrationValue(store.setIfAbsent(NAMESPACE, input.projectId, value))).created
        : yield* integrationValue(store.compareAndSet(NAMESPACE, input.projectId, observed.updatedAt, value, observed.value));
      if (!written) throw new Error(`The standby record of Project "${input.projectId}" changed while it was being written.`);
      return record;
    })),
  };
}

/** Project deletion participant: no standby record outlives its Project. */
export function deleteProjectStandby(store: ZelavisSystemStore, projectId: string): Promise<void> {
  return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
    if (!validId(projectId)) throw new TypeError("Invalid Project id for standby cleanup");
    yield* integrationValue(store.delete(NAMESPACE, projectId));
  }));
}
