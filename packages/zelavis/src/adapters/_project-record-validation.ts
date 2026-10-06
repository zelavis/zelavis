import type { ZelavisProjectDriverCapabilities } from "../core/workload/index.js";
import {
  objectFields, optional, arrayOf, literal, isString, isFiniteNumber, isBoolean, isTimestamp,
} from "../core/json-validation.js";
import type { ZelavisProjectDescriptor, ZelavisProjectRecipeLock, ZelavisProjectRecord } from "../project.js";
import type {
  ZelavisProjectIsolationIntent, ZelavisResourceLimitIntent, ZelavisProjectResourceIntent,
} from "../project-isolation.js";

const enforcement = literal("required", "advisory");
const resource = objectFields<ZelavisResourceLimitIntent>({ limit: isFiniteNumber, enforcement });
const resources = objectFields<ZelavisProjectResourceIntent>({ cpuMillicores: optional(resource), memoryMiB: optional(resource), pids: optional(resource), diskMiB: optional(resource) });
const isolation = objectFields<ZelavisProjectIsolationIntent>({
  boundary: optional(objectFields<NonNullable<ZelavisProjectIsolationIntent["boundary"]>>({ minimum: literal("process", "os-container", "microvm"), enforcement })),
  filesystem: optional(enforcement), process: optional(enforcement), network: optional(enforcement), resources: optional(resources),
});
const recipe = objectFields<ZelavisProjectRecipeLock>({ name: isString, title: isString, version: isString,
  specifier: isString, runtimeKinds: arrayOf(isString), hostPackages: optional(arrayOf(isString)),
  isolation: optional(isolation), managed: optional(objectFields<{ adminTitle?: string; adminPath?: string }>({
    adminTitle: optional(isString), adminPath: optional(isString) })),
  artifact: optional(objectFields<{ digest: string }>({ digest: runtimeReleaseRecordDigest })),
});
function runtimeReleaseRecordDigest(value: unknown): value is string {
  return isString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}
/** Frozen host files carry a descriptor, not live registry/runtime state. */
export const projectDescriptorRecord = objectFields<ZelavisProjectDescriptor>({
  id: isString, name: isString, kind: isString, recipe, runtimeKind: isString,
  engineVersion: optional(isString), ownerProjectId: optional(isString),
});

const capabilities = objectFields<ZelavisProjectDriverCapabilities>({ movable: isBoolean, liveMigration: isBoolean,
  persistentFilesystem: isBoolean, resourceLimits: isBoolean, statelessRuntimeReplicas: isBoolean,
  managedStorage: isBoolean, managedDatabase: isBoolean, databaseReplication: isBoolean,
  tenantPlacement: isBoolean, databaseSharding: isBoolean, independentRuntimeVersion: isBoolean,
  zeroDowntimeUpdates: optional(isBoolean), recipeUpdateMode: optional(literal("engine", "integration")),
  secureIsolation: isBoolean, runtimeOwnership: literal("platform-process", "zelavis-agent"),
  survivesControlPlaneRestart: isBoolean, description: isString });
type PreparedProject = ZelavisProjectDescriptor & Pick<ZelavisProjectRecord, "createdAt" | "updatedAt" | "desiredState"> & {
  runtime: { driver: string; capabilities: ZelavisProjectDriverCapabilities };
};
export const preparedProjectRecord = objectFields<PreparedProject>({
  id: isString, name: isString, kind: isString, recipe, runtimeKind: isString,
  engineVersion: optional(isString), ownerProjectId: optional(isString),
  createdAt: isTimestamp, updatedAt: isTimestamp, desiredState: literal("running", "stopped"),
  runtime: objectFields<PreparedProject["runtime"]>({ driver: isString, capabilities }),
});
/** A frozen descriptor has no live process status; dispatch creates that state. */
export function projectForRemoteStart(prepared: PreparedProject): ZelavisProjectRecord {
  return { id: prepared.id, name: prepared.name, kind: prepared.kind,
    recipe: prepared.recipe, runtimeKind: prepared.runtimeKind,
    engineVersion: prepared.engineVersion, ownerProjectId: prepared.ownerProjectId,
    createdAt: prepared.createdAt, updatedAt: prepared.updatedAt, desiredState: prepared.desiredState,
    capabilities: prepared.runtime.capabilities,
    runtime: { driver: prepared.runtime.driver, status: "stopped" } };
}
