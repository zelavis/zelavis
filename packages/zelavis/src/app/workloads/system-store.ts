import { Effect } from "effect";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../../system-store.js";
import { integration, presentOperations } from "../../core/runtime/effect-boundary.js";
import type { WorkloadDefinition, WorkloadRunLog, WorkloadsStore } from "./workloads-service.js";

/** The runtime's private store keeps workloads across engine handovers. */
export function createSystemStoreWorkloadsStore(store: ZelavisSystemStore): WorkloadsStore {
  const definitions = "zelavis.workloads.definitions", runs = "zelavis.workloads.runs";
  return presentOperations({
    list: Effect.fn("WorkloadsStore.list")(function* (filter?: { projectId?: string; type?: WorkloadDefinition["type"] }) {
      const records = yield* integration(() => store.list(definitions));
      return records.map(record => record.value as unknown as WorkloadDefinition).filter(workload =>
        (!filter?.projectId || workload.projectId === filter.projectId) && (!filter?.type || workload.type === filter.type));
    }),
    read: Effect.fn("WorkloadsStore.read")(function* (id: string) {
      const record = yield* integration(() => store.get(definitions, id));
      return record?.value as unknown as WorkloadDefinition | undefined;
    }),
    save: Effect.fn("WorkloadsStore.save")(function* (workload: WorkloadDefinition) {
      yield* integration(() => store.set(definitions, workload.id, workload as unknown as ZelavisSystemStoreValue));
      return workload;
    }),
    logs: Effect.fn("WorkloadsStore.logs")(function* (filter?: { projectId?: string; workloadId?: string }) {
      const records = yield* integration(() => store.list(runs));
      return records.map(record => record.value as unknown as WorkloadRunLog).filter(log =>
        (!filter?.projectId || log.projectId === filter.projectId) && (!filter?.workloadId || log.workloadId === filter.workloadId));
    }),
    appendLog: Effect.fn("WorkloadsStore.appendLog")(function* (log: WorkloadRunLog) {
      yield* integration(() => store.set(runs, log.id, log as unknown as ZelavisSystemStoreValue));
      return log;
    }),
  });
}
