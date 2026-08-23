import type { ZelavisRuntimeService } from "@zelavis/server";
export type WorkloadType = "function" | "job" | "schedule" | "webhook";
export interface WorkloadDefinition {
    id: string;
    projectId: string;
    type: WorkloadType;
    name: string;
    code: string;
    route?: string;
    schedule?: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface WorkloadRunLog {
    id: string;
    workloadId: string;
    projectId: string;
    status: "completed" | "failed";
    responseStatus?: number;
    output: string;
    createdAt: string;
}
export interface WorkloadsStore {
    list: (filter?: {
        projectId?: string;
        type?: WorkloadType;
    }) => Promise<readonly WorkloadDefinition[]> | readonly WorkloadDefinition[];
    read: (id: string) => Promise<WorkloadDefinition | undefined> | WorkloadDefinition | undefined;
    save: (workload: WorkloadDefinition) => Promise<WorkloadDefinition> | WorkloadDefinition;
    logs: (filter?: {
        projectId?: string;
        workloadId?: string;
    }) => Promise<readonly WorkloadRunLog[]> | readonly WorkloadRunLog[];
    appendLog: (log: WorkloadRunLog) => Promise<WorkloadRunLog> | WorkloadRunLog;
}
export interface WorkloadsServiceOptions {
    store?: WorkloadsStore;
}
export interface WorkloadsApi {
    store: WorkloadsStore;
}
export interface WorkloadExecutionResult {
    headers?: Record<string, string>;
    output: string;
    status: "completed" | "failed";
    responseStatus?: number;
}
export declare function createMemoryWorkloadsStore(seed?: readonly WorkloadDefinition[]): WorkloadsStore;
export declare function workloadsService(options?: WorkloadsServiceOptions): ZelavisRuntimeService<WorkloadsApi>;
