export type ZelavisRuntimeAuthorityScope = "platform" | "project";

export interface ZelavisParentAuthority {
  readonly scope: ZelavisRuntimeAuthorityScope;
  readonly scopeId: string;
}

export interface ZelavisRuntimeAuthority {
  readonly scope: ZelavisRuntimeAuthorityScope;
  readonly scopeId: string;
  readonly parent?: ZelavisParentAuthority;
  readonly capabilities: readonly string[];
}

export type ZelavisWorkloadType = "project" | "tenant" | "shard";

export interface ZelavisWorkloadIdentity {
  readonly scopeId: string;
  readonly workloadId: string;
  readonly type: ZelavisWorkloadType;
}

export interface ZelavisProjectWorkloadIdentity
  extends ZelavisWorkloadIdentity {
  readonly type: "project";
}

export interface ZelavisProjectWorkloadCapabilities {
  readonly movable: boolean;
  readonly liveMigration: boolean;
  readonly persistentFilesystem: boolean;
  readonly resourceLimits: boolean;
  readonly statelessRuntimeReplicas: boolean;
  readonly managedStorage: boolean;
  readonly managedDatabase: boolean;
  readonly databaseReplication: boolean;
  readonly tenantPlacement: boolean;
  readonly databaseSharding: boolean;
}

export interface ZelavisProjectDriverCapabilities
  extends ZelavisProjectWorkloadCapabilities {
  readonly secureIsolation: boolean;
  readonly runtimeOwnership: "platform-process" | "zelavis-agent";
  readonly survivesControlPlaneRestart: boolean;
  readonly description: string;
}

export interface ZelavisProjectResourceEnvelope {
  readonly projectId: string;
  readonly cpuLimit?: number;
  readonly memoryLimitBytes?: number;
  readonly storageLimitBytes?: number;
  readonly allowedAllocationIds: readonly string[];
  readonly maxRuntimeReplicas: number;
}

export type ZelavisWorkloadPlacementState =
  | "active"
  | "preparing"
  | "moving"
  | "recovering"
  | "unavailable";

export interface ZelavisWorkloadPlacement<
  TIdentity extends ZelavisWorkloadIdentity = ZelavisWorkloadIdentity,
> {
  readonly identity: TIdentity;
  readonly runtimeNodeId: string;
  readonly databaseNodeId?: string;
  readonly generation: number;
  readonly state: ZelavisWorkloadPlacementState;
}

export type ZelavisNodeRole = "gateway" | "control" | "worker";

export interface ZelavisAgentDescriptor {
  readonly nodeId: string;
  readonly roles: readonly ZelavisNodeRole[];
  readonly runtimeDrivers: readonly string[];
}
