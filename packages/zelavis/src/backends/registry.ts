import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "../system-store.js";
import type {
  ZelavisProjectDescriptor,
  ZelavisProjectRuntimeDriver,
  ZelavisProjectRuntimeKind,
} from "../project.js";
import { ZelavisProjectRuntimeError } from "../project.js";

export type ZelavisDeploymentBackendFeatureState =
  | "available"
  | "unavailable"
  | "planned";

export interface ZelavisDeploymentBackendCapabilities {
  readonly isolationBoundary: "process" | "os-container" | "microvm";
  readonly filesystemIsolation: ZelavisDeploymentBackendFeatureState;
  readonly processIsolation: ZelavisDeploymentBackendFeatureState;
  readonly networkIsolation: ZelavisDeploymentBackendFeatureState;
  readonly resourceLimits: ZelavisDeploymentBackendFeatureState;
  readonly exec: ZelavisDeploymentBackendFeatureState;
  readonly persistentStorage: ZelavisDeploymentBackendFeatureState;
  readonly snapshots: ZelavisDeploymentBackendFeatureState;
  readonly images: ZelavisDeploymentBackendFeatureState;
  readonly description: string;
}

export interface ZelavisDeploymentBackendDetection {
  readonly state: "ready" | "degraded" | "unavailable";
  readonly installed: boolean;
  readonly healthy: boolean;
  readonly version?: string;
  readonly apiVersion?: string;
  readonly rootless?: boolean;
  readonly checkedAt: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly error?: string;
}

export interface ZelavisDeploymentBackendAdapter {
  readonly id: string;
  readonly title: string;
  readonly capabilities: ZelavisDeploymentBackendCapabilities;
  /** Project execution implementation owned by this backend, when operational. */
  readonly projectRuntime?: ZelavisProjectRuntimeDriver;
  detect(): Promise<ZelavisDeploymentBackendDetection>;
}

export interface ZelavisDeploymentBackendSnapshot {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  /** A Project runtime driver is registered for this backend. */
  readonly executable: boolean;
  readonly capabilities: ZelavisDeploymentBackendCapabilities;
  readonly detection: ZelavisDeploymentBackendDetection;
}

export interface ZelavisDeploymentBackendPolicy {
  readonly defaultBackend: string;
  readonly enabledBackends: readonly string[];
  readonly updatedAt: string;
}

export interface ZelavisDeploymentBackendManager {
  list(options?: { refresh?: boolean }): Promise<readonly ZelavisDeploymentBackendSnapshot[]>;
  detect(id?: string): Promise<readonly ZelavisDeploymentBackendSnapshot[]>;
  getPolicy(): Promise<ZelavisDeploymentBackendPolicy>;
  enable(id: string): Promise<ZelavisDeploymentBackendPolicy>;
  disable(id: string): Promise<ZelavisDeploymentBackendPolicy>;
  setDefault(id: string): Promise<ZelavisDeploymentBackendPolicy>;
}

export class ZelavisDeploymentBackendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisDeploymentBackendValidationError";
  }
}

export class ZelavisDeploymentBackendConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisDeploymentBackendConflictError";
  }
}

const STORE_NAMESPACE = "deployment-backends";
const POLICY_KEY = "policy";
const DETECTION_PREFIX = "detection:";
const NATIVE_BACKEND = "native";
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function normalizeBackendId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!BACKEND_ID_PATTERN.test(id) || id.length > 64) {
    throw new ZelavisDeploymentBackendValidationError(
      "Deployment backend id must be a lowercase slug of at most 64 characters.",
    );
  }
  return id;
}

function toStoreValue(value: unknown): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(value)) as ZelavisSystemStoreValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readDetection(
  value: ZelavisSystemStoreValue | undefined,
): ZelavisDeploymentBackendDetection | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.state !== "ready" &&
      value.state !== "degraded" &&
      value.state !== "unavailable") ||
    typeof value.installed !== "boolean" ||
    typeof value.healthy !== "boolean" ||
    typeof value.checkedAt !== "string"
  ) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as ZelavisDeploymentBackendDetection;
}

function normalizeDetection(
  detection: ZelavisDeploymentBackendDetection,
): ZelavisDeploymentBackendDetection {
  const checkedAt = new Date(detection.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    throw new ZelavisDeploymentBackendValidationError(
      "Deployment backend detection returned an invalid checkedAt timestamp.",
    );
  }
  if (detection.state === "ready" && (!detection.installed || !detection.healthy)) {
    throw new ZelavisDeploymentBackendValidationError(
      "A ready deployment backend detection must be installed and healthy.",
    );
  }
  return JSON.parse(JSON.stringify(detection)) as ZelavisDeploymentBackendDetection;
}

export function createDeploymentBackendManager(options: {
  store: ZelavisSystemStore;
  backends: readonly ZelavisDeploymentBackendAdapter[];
  assignedProjectCount?: (backendId: string) => Promise<number>;
}): ZelavisDeploymentBackendManager {
  const definitions = new Map<string, ZelavisDeploymentBackendAdapter>();
  for (const definition of options.backends) {
    const id = normalizeBackendId(definition.id);
    if (definitions.has(id)) {
      throw new ZelavisDeploymentBackendValidationError(
        `Duplicate deployment backend definition "${id}".`,
      );
    }
    definitions.set(id, Object.freeze({ ...definition, id }));
  }
  if (!definitions.has(NATIVE_BACKEND)) {
    throw new ZelavisDeploymentBackendValidationError(
      'A deployment backend definition for "native" is required.',
    );
  }
  let policyMutationQueue: Promise<void> = Promise.resolve();

  function serializePolicyMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = policyMutationQueue.then(operation, operation);
    policyMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readPolicy(): Promise<ZelavisDeploymentBackendPolicy> {
    const stored = await options.store.get(STORE_NAMESPACE, POLICY_KEY);
    if (!stored) {
      const policy: ZelavisDeploymentBackendPolicy = {
        defaultBackend: NATIVE_BACKEND,
        enabledBackends: [NATIVE_BACKEND],
        updatedAt: new Date().toISOString(),
      };
      await options.store.set(STORE_NAMESPACE, POLICY_KEY, toStoreValue(policy));
      return policy;
    }
    if (!isRecord(stored.value)) {
      throw new ZelavisDeploymentBackendValidationError(
        "Stored deployment backend policy is invalid.",
      );
    }
    const defaultBackend = typeof stored.value.defaultBackend === "string"
      ? normalizeBackendId(stored.value.defaultBackend)
      : "";
    const enabledBackends = Array.isArray(stored.value.enabledBackends)
      ? [...new Set(stored.value.enabledBackends.map((value) =>
          typeof value === "string" ? normalizeBackendId(value) : "",
        ))]
      : [];
    if (
      !defaultBackend ||
      !definitions.has(defaultBackend) ||
      !enabledBackends.includes(NATIVE_BACKEND) ||
      !enabledBackends.includes(defaultBackend) ||
      enabledBackends.some((id) => !definitions.has(id))
    ) {
      throw new ZelavisDeploymentBackendValidationError(
        "Stored deployment backend policy is invalid.",
      );
    }
    return {
      defaultBackend,
      enabledBackends,
      updatedAt:
        typeof stored.value.updatedAt === "string"
          ? stored.value.updatedAt
          : stored.updatedAt,
    };
  }

  async function writePolicy(input: {
    defaultBackend: string;
    enabledBackends: readonly string[];
  }): Promise<ZelavisDeploymentBackendPolicy> {
    const policy: ZelavisDeploymentBackendPolicy = {
      defaultBackend: normalizeBackendId(input.defaultBackend),
      enabledBackends: Object.freeze([
        ...new Set(input.enabledBackends.map(normalizeBackendId)),
      ]),
      updatedAt: new Date().toISOString(),
    };
    await options.store.set(STORE_NAMESPACE, POLICY_KEY, toStoreValue(policy));
    return policy;
  }

  async function detectDefinition(
    definition: ZelavisDeploymentBackendAdapter,
  ): Promise<ZelavisDeploymentBackendDetection> {
    let detection: ZelavisDeploymentBackendDetection;
    try {
      detection = normalizeDetection(await definition.detect());
    } catch (error) {
      detection = {
        state: "unavailable",
        installed: false,
        healthy: false,
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await options.store.set(
      STORE_NAMESPACE,
      `${DETECTION_PREFIX}${definition.id}`,
      toStoreValue(detection),
    );
    return detection;
  }

  async function snapshot(
    definition: ZelavisDeploymentBackendAdapter,
    policy: ZelavisDeploymentBackendPolicy,
    refresh: boolean,
  ): Promise<ZelavisDeploymentBackendSnapshot> {
    const detectionRecord = refresh
      ? undefined
      : await options.store.get(
          STORE_NAMESPACE,
          `${DETECTION_PREFIX}${definition.id}`,
        );
    const detection = readDetection(detectionRecord?.value) ??
      await detectDefinition(definition);
    return {
      id: definition.id,
      title: definition.title,
      enabled: policy.enabledBackends.includes(definition.id),
      isDefault: policy.defaultBackend === definition.id,
      executable: Boolean(definition.projectRuntime),
      capabilities: definition.capabilities,
      detection,
    };
  }

  async function requireReadyExecutable(id: string) {
    const definition = definitions.get(normalizeBackendId(id));
    if (!definition) {
      throw new ZelavisDeploymentBackendValidationError(
        `Deployment backend "${id}" is not registered.`,
      );
    }
    const detection = await detectDefinition(definition);
    if (detection.state !== "ready") {
      throw new ZelavisDeploymentBackendConflictError(
        `Deployment backend "${definition.id}" is not healthy on this server.`,
      );
    }
    if (!definition.projectRuntime) {
      throw new ZelavisDeploymentBackendConflictError(
        `Deployment backend "${definition.id}" has no registered Project runtime driver.`,
      );
    }
    return definition;
  }

  return {
    async list(listOptions = {}) {
      const policy = await readPolicy();
      return Promise.all(
        [...definitions.values()].map((definition) =>
          snapshot(definition, policy, listOptions.refresh === true),
        ),
      );
    },
    async detect(id) {
      const policy = await readPolicy();
      const selected = id
        ? [definitions.get(normalizeBackendId(id))].filter(
            (definition): definition is ZelavisDeploymentBackendAdapter =>
              Boolean(definition),
          )
        : [...definitions.values()];
      if (selected.length === 0) {
        throw new ZelavisDeploymentBackendValidationError(
          `Deployment backend "${id}" is not registered.`,
        );
      }
      return Promise.all(
        selected.map((definition) => snapshot(definition, policy, true)),
      );
    },
    getPolicy: readPolicy,
    enable(id) {
      return serializePolicyMutation(async () => {
        const definition = await requireReadyExecutable(id);
        const policy = await readPolicy();
        return writePolicy({
          defaultBackend: policy.defaultBackend,
          enabledBackends: [...policy.enabledBackends, definition.id],
        });
      });
    },
    disable(id) {
      return serializePolicyMutation(async () => {
        const backendId = normalizeBackendId(id);
        if (backendId === NATIVE_BACKEND) {
          throw new ZelavisDeploymentBackendConflictError(
            "The native deployment backend cannot be disabled.",
          );
        }
        const policy = await readPolicy();
        if (policy.defaultBackend === backendId) {
          throw new ZelavisDeploymentBackendConflictError(
            `Deployment backend "${backendId}" is the server default and cannot be disabled.`,
          );
        }
        const assigned = await options.assignedProjectCount?.(backendId) ?? 0;
        if (assigned > 0) {
          throw new ZelavisDeploymentBackendConflictError(
            `Deployment backend "${backendId}" still owns ${assigned} Project${assigned === 1 ? "" : "s"}.`,
          );
        }
        return writePolicy({
          defaultBackend: policy.defaultBackend,
          enabledBackends: policy.enabledBackends.filter((value) => value !== backendId),
        });
      });
    },
    setDefault(id) {
      return serializePolicyMutation(async () => {
        const definition = await requireReadyExecutable(id);
        const policy = await readPolicy();
        if (!policy.enabledBackends.includes(definition.id)) {
          throw new ZelavisDeploymentBackendConflictError(
            `Deployment backend "${definition.id}" must be enabled before it can become the default.`,
          );
        }
        return writePolicy({
          defaultBackend: definition.id,
          enabledBackends: policy.enabledBackends,
        });
      });
    },
  };
}

/**
 * Composes backend-owned Project drivers behind the existing lifecycle contract.
 * Stored Project assignment remains the only dispatch authority.
 */
export function createDeploymentBackendProjectRuntime(options: {
  store: ZelavisSystemStore;
  backends: readonly ZelavisDeploymentBackendAdapter[];
}): ZelavisProjectRuntimeDriver | undefined {
  const runtimes = new Map<ZelavisProjectRuntimeKind, ZelavisProjectRuntimeDriver>();
  for (const backend of options.backends) {
    const id = normalizeBackendId(backend.id);
    if (!backend.projectRuntime) continue;
    if (runtimes.has(id)) {
      throw new ZelavisDeploymentBackendValidationError(
        `Duplicate Project runtime for deployment backend "${id}".`,
      );
    }
    if (
      backend.projectRuntime.runtimeKinds &&
      !backend.projectRuntime.runtimeKinds.includes(id)
    ) {
      throw new ZelavisDeploymentBackendValidationError(
        `Project driver "${backend.projectRuntime.name}" does not advertise backend "${id}".`,
      );
    }
    runtimes.set(id, backend.projectRuntime);
  }
  if (runtimes.size === 0) return undefined;

  const forDescriptor = (project: Readonly<ZelavisProjectDescriptor>) => {
    const runtime = runtimes.get(normalizeBackendId(project.runtimeKind));
    if (!runtime) {
      throw new ZelavisProjectRuntimeError(
        `No Project driver is registered for deployment backend "${project.runtimeKind}".`,
      );
    }
    return runtime;
  };
  const forProjectId = async (projectId: string) => {
    const record = await options.store.get("projects", projectId);
    const value = record?.value;
    const runtimeKind = isRecord(value) && typeof value.runtimeKind === "string"
      ? value.runtimeKind
      : NATIVE_BACKEND;
    const runtime = runtimes.get(normalizeBackendId(runtimeKind));
    if (!runtime) {
      throw new ZelavisProjectRuntimeError(
        `No Project driver is registered for deployment backend "${runtimeKind}".`,
      );
    }
    return runtime;
  };
  const uniqueRuntimes = [...new Set(runtimes.values())];

  return {
    name: "deployment-backends",
    runtimeKinds: Object.freeze([...runtimes.keys()]),
    defaultRuntimeKind: runtimes.has(NATIVE_BACKEND)
      ? NATIVE_BACKEND
      : [...runtimes.keys()][0],
    startupConcurrency: Math.min(
      ...uniqueRuntimes.map((runtime) => runtime.startupConcurrency ?? 4),
    ),
    capabilities: (project) => forDescriptor(project).capabilities(project),
    prepare: (project, app) => forDescriptor(project).prepare(project, app),
    start: (project) => forDescriptor(project).start(project),
    stop: async (projectId) => (await forProjectId(projectId)).stop(projectId),
    status: async (projectId) => (await forProjectId(projectId)).status(projectId),
    logs: async (projectId) => (await forProjectId(projectId)).logs(projectId),
    destroy: async (projectId) => (await forProjectId(projectId)).destroy(projectId),
    close: async () => {
      await Promise.all(uniqueRuntimes.map((runtime) => runtime.close()));
    },
    signGatewayAuthority: async (projectId, claims) =>
      (await forProjectId(projectId)).signGatewayAuthority?.(projectId, claims),
  };
}
