import type { ZelavisProjectDriverCapabilities } from "./core/index.js";
import type {
  ZelavisServiceDefinition,
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "./service.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "./system-store.js";

export type ZelavisProjectRuntimeStatus =
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ZelavisProjectRuntimeState {
  driver: string;
  status: ZelavisProjectRuntimeStatus;
  url?: string;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}

export interface ZelavisProjectDeletionState {
  status: "running" | "failed";
  startedAt: string;
  updatedAt: string;
  participants: readonly string[];
  completedParticipants: readonly string[];
  currentParticipant?: string;
  error?: string;
}

export type ZelavisProjectKind = string;

export interface ZelavisProjectApp {
  name: string;
  title: string;
  /** Exact recipe/runtime version. Platform upgrades must never rewrite this lock. */
  version: string;
  specifier: string;
}

export interface ZelavisProjectDescriptor {
  id: string;
  name: string;
  kind: ZelavisProjectKind;
  app: ZelavisProjectApp;
}

export interface ZelavisProjectRecord extends ZelavisProjectDescriptor {
  capabilities: ZelavisProjectDriverCapabilities;
  desiredState: "running" | "stopped";
  runtime: ZelavisProjectRuntimeState;
  deletion?: ZelavisProjectDeletionState;
  createdAt: string;
  updatedAt: string;
}

export interface ZelavisProjectCleanupParticipant {
  /** Stable durable identifier. Renaming it changes persisted resume state. */
  readonly id: string;
  cleanup(project: Readonly<ZelavisProjectRecord>): Promise<void>;
}

export interface ZelavisProjectRuntimeSnapshot {
  status: Exclude<ZelavisProjectRuntimeStatus, "provisioning">;
  url?: string;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}

export interface ZelavisProjectLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface ZelavisProjectRuntimeDriver {
  readonly name: string;
  readonly startupConcurrency?: number;
  capabilities(
    project: Readonly<ZelavisProjectDescriptor>,
  ): ZelavisProjectDriverCapabilities;
  prepare(
    project: ZelavisProjectRecord,
    app: ZelavisProjectApp,
  ): Promise<void>;
  start(project: ZelavisProjectRecord): Promise<ZelavisProjectRuntimeSnapshot>;
  stop(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  status(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  destroy(projectId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ZelavisProjectCreateInput {
  name: string;
  id?: string;
  appServiceName?: string;
  start?: boolean;
}

export interface ZelavisProjectManager {
  readonly runtime: {
    driver: string;
  };
  list(): Promise<readonly ZelavisProjectRecord[]>;
  get(id: string): Promise<ZelavisProjectRecord | undefined>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  start(id: string): Promise<ZelavisProjectRecord>;
  stop(id: string): Promise<ZelavisProjectRecord>;
  restart(id: string): Promise<ZelavisProjectRecord>;
  logs(id: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(id: string): Promise<boolean>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export class ZelavisProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectValidationError";
  }
}

export class ZelavisProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectConflictError";
  }
}

export class ZelavisProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectNotFoundError";
  }
}

export class ZelavisProjectDeletionError extends Error {
  readonly projectId: string;
  readonly participantId: string;

  constructor(input: {
    projectId: string;
    participantId: string;
    cause: unknown;
  }) {
    const causeMessage =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(
      `Project "${input.projectId}" deletion failed during "${input.participantId}": ${causeMessage}`,
      { cause: input.cause },
    );
    this.name = "ZelavisProjectDeletionError";
    this.projectId = input.projectId;
    this.participantId = input.participantId;
  }
}

const PROJECTS_NAMESPACE = "projects";
const DEFAULT_APP_SERVICE_NAME = "zelavis/app";
const DEFAULT_STARTUP_CONCURRENCY = 1;
const RUNTIME_DATA_CLEANUP_PARTICIPANT = "runtime-data";
const RETIRED_OFFICIAL_APP_LOCKS = new Map([
  ["@zelavis/app", DEFAULT_APP_SERVICE_NAME],
]);

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_STARTUP_CONCURRENCY;
  }

  return Math.max(1, Math.floor(value));
}

async function mapWithConcurrency<TValue, TResult>(
  values: readonly TValue[],
  concurrency: number,
  map: (value: TValue, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await map(values[index]!, index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}

function normalizeProjectId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new ZelavisProjectValidationError(
      "Project id must contain at least one letter or number.",
    );
  }

  return normalized;
}

function normalizeProjectName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ZelavisProjectValidationError("Project name is required.");
  }
  return normalized;
}

function normalizeCleanupParticipantId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new ZelavisProjectValidationError(
      "Project cleanup participant IDs must use lowercase letters, numbers, and hyphens.",
    );
  }
  return normalized;
}

function readStoredDeletionState(
  rawProject: Record<string, unknown>,
): ZelavisProjectDeletionState | undefined {
  const raw = rawProject.deletion;
  if (raw === undefined) return undefined;
  if (!isObjectRecord(raw)) {
    throw new ZelavisProjectValidationError(
      "Stored project deletion state is invalid.",
    );
  }
  if (
    (raw.status !== "running" && raw.status !== "failed") ||
    typeof raw.startedAt !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Array.isArray(raw.participants) ||
    !raw.participants.every((value) => typeof value === "string") ||
    !Array.isArray(raw.completedParticipants) ||
    !raw.completedParticipants.every((value) => typeof value === "string") ||
    (raw.currentParticipant !== undefined &&
      typeof raw.currentParticipant !== "string") ||
    (raw.error !== undefined && typeof raw.error !== "string")
  ) {
    throw new ZelavisProjectValidationError(
      "Stored project deletion state is invalid.",
    );
  }
  return {
    status: raw.status,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    participants: [...raw.participants],
    completedParticipants: [...raw.completedParticipants],
    ...(raw.currentParticipant
      ? { currentParticipant: raw.currentParticipant }
      : {}),
    ...(raw.error ? { error: raw.error } : {}),
  };
}

function toStoreValue(project: ZelavisProjectRecord): ZelavisSystemStoreValue {
  return JSON.parse(JSON.stringify(project)) as ZelavisSystemStoreValue;
}

function parseStoredProject(value: ZelavisSystemStoreValue): ZelavisProjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ZelavisProjectValidationError("Stored project record is invalid.");
  }

  return JSON.parse(JSON.stringify(value)) as ZelavisProjectRecord;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function applySnapshot(
  project: ZelavisProjectRecord,
  snapshot: ZelavisProjectRuntimeSnapshot,
): ZelavisProjectRecord {
  return {
    ...project,
    runtime: {
      driver: project.runtime.driver,
      ...snapshot,
    },
    updatedAt: new Date().toISOString(),
  };
}

function projectKindFromAppService(serviceName: string): ZelavisProjectKind {
  if (serviceName === "zelavis/app") {
    return "zelavis";
  }

  return serviceName
    .replace(/^@/, "")
    .replace(/^zelavis\//, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "generic";
}

function appTitleFromService(
  service: Readonly<ZelavisServiceDefinition<ZelavisServiceSetupContext>>,
) {
  return service.marketplace?.title ?? service.menu?.title ?? service.name;
}

function appLockFromRegistryEntry(
  entry: Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>,
): ZelavisProjectApp {
  if (!entry.service.version) {
    throw new ZelavisProjectValidationError(
      `App service "${entry.service.name}" must declare an exact version.`,
    );
  }

  return {
    name: entry.service.name,
    title: appTitleFromService(entry.service),
    version: entry.service.version,
    specifier: entry.specifier ?? entry.service.name,
  };
}

function readStoredAppLock(rawProject: Record<string, unknown>): ZelavisProjectApp {
  const rawApp = rawProject.app;
  if (!isObjectRecord(rawApp)) {
    throw new ZelavisProjectValidationError(
      "Stored project record is missing its app release lock.",
    );
  }

  const fields = ["name", "title", "version", "specifier"] as const;
  for (const field of fields) {
    if (typeof rawApp[field] !== "string" || rawApp[field].trim().length === 0) {
      throw new ZelavisProjectValidationError(
        `Stored project app release ${field} must be a non-empty string.`,
      );
    }
  }

  return {
    name: rawApp.name as string,
    title: rawApp.title as string,
    version: rawApp.version as string,
    specifier: rawApp.specifier as string,
  };
}

export async function createProjectManager(options: {
  store: ZelavisSystemStore;
  appServices: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  runtime: ZelavisProjectRuntimeDriver;
  cleanupParticipants?: readonly ZelavisProjectCleanupParticipant[];
}): Promise<ZelavisProjectManager> {
  const { store, appServices, runtime } = options;
  const startupConcurrency = normalizeConcurrency(runtime.startupConcurrency);
  let closing = false;
  let reconciliationPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const deletionPromises = new Map<string, Promise<boolean>>();
  const cleanupParticipants = [
    ...(options.cleanupParticipants ?? []),
    {
      id: RUNTIME_DATA_CLEANUP_PARTICIPANT,
      cleanup: (project: Readonly<ZelavisProjectRecord>) =>
        runtime.destroy(project.id),
    },
  ].map((participant) => ({
    ...participant,
    id: normalizeCleanupParticipantId(participant.id),
  }));
  const cleanupParticipantIds = new Set<string>();
  for (const participant of cleanupParticipants) {
    if (cleanupParticipantIds.has(participant.id)) {
      throw new ZelavisProjectValidationError(
        `Duplicate Project cleanup participant "${participant.id}".`,
      );
    }
    cleanupParticipantIds.add(participant.id);
  }

  const appServiceMap = new Map(
    appServices
      .filter((entry) => entry.service.kind === "app")
      .map((entry) => [entry.service.name, entry]),
  );

  function normalizeStoredProject(value: ZelavisSystemStoreValue): {
    project: ZelavisProjectRecord;
    repaired: boolean;
  } {
    const rawProject = parseStoredProject(value);
    const rawRecord = rawProject as unknown as Record<string, unknown>;
    const storedApp = readStoredAppLock(rawRecord);
    const deletion = readStoredDeletionState(rawRecord);
    const replacementName =
      RETIRED_OFFICIAL_APP_LOCKS.get(storedApp.name) ??
      RETIRED_OFFICIAL_APP_LOCKS.get(storedApp.specifier);
    const replacement = replacementName
      ? appServiceMap.get(replacementName)
      : undefined;
    const app = replacement
      ? {
          ...storedApp,
          name: replacement.service.name,
          title: appTitleFromService(replacement.service),
          specifier: replacement.specifier ?? replacement.service.name,
        }
      : storedApp;
    const descriptor: ZelavisProjectDescriptor = {
      id: rawProject.id,
      name: rawProject.name,
      kind: rawProject.kind || projectKindFromAppService(app.name),
      app,
    };
    const capabilities = runtime.capabilities(descriptor);
    const project: ZelavisProjectRecord = {
      ...descriptor,
      capabilities,
      desiredState: rawProject.desiredState,
      runtime:
        rawProject.runtime?.driver && rawProject.runtime.status
          ? rawProject.runtime
          : {
              driver: runtime.name,
              status: "stopped",
            },
      ...(deletion ? { deletion } : {}),
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };

    return {
      project,
      repaired:
        JSON.stringify(storedApp) !== JSON.stringify(app) ||
        rawProject.kind !== project.kind ||
        JSON.stringify(rawRecord.capabilities) !==
          JSON.stringify(capabilities) ||
        rawProject.runtime !== project.runtime,
    };
  }

  async function read(id: string): Promise<ZelavisProjectRecord | undefined> {
    const record = await store.get(PROJECTS_NAMESPACE, normalizeProjectId(id));
    if (!record) {
      return undefined;
    }

    const { project, repaired } = normalizeStoredProject(record.value);
    if (repaired) {
      await write(project);
    }
    return project;
  }

  async function write(project: ZelavisProjectRecord): Promise<ZelavisProjectRecord> {
    await store.set(PROJECTS_NAMESPACE, project.id, toStoreValue(project));
    return project;
  }

  async function requireProject(id: string): Promise<ZelavisProjectRecord> {
    const project = await read(id);
    if (!project) {
      throw new ZelavisProjectNotFoundError(`Project "${id}" was not found.`);
    }
    return project;
  }

  function assertProjectIsOperable(
    project: ZelavisProjectRecord,
    operation: string,
  ): void {
    if (project.deletion) {
      throw new ZelavisProjectConflictError(
        `Project "${project.id}" is pending deletion and cannot be ${operation}. Retry deletion instead.`,
      );
    }
  }

  async function refresh(project: ZelavisProjectRecord): Promise<ZelavisProjectRecord> {
    if (project.runtime.status === "provisioning" || project.deletion) {
      return project;
    }

    const snapshot = await runtime.status(project.id);
    const unchanged =
      snapshot.status === project.runtime.status &&
      snapshot.url === project.runtime.url &&
      snapshot.error === project.runtime.error;
    return unchanged ? project : write(applySnapshot(project, snapshot));
  }

  async function deleteProject(id: string): Promise<boolean> {
    const existingProject = await read(id);
    if (!existingProject) {
      return false;
    }
    let project: ZelavisProjectRecord = existingProject;

    const startedAt = project.deletion?.startedAt ?? new Date().toISOString();
    const completedParticipants = new Set(
      project.deletion?.completedParticipants ?? [],
    );
    const plannedParticipants = [
      ...new Set([
        ...(project.deletion?.participants ?? []).filter(
          (id) => id !== RUNTIME_DATA_CLEANUP_PARTICIPANT,
        ),
        ...cleanupParticipants
          .map((participant) => participant.id)
          .filter((id) => id !== RUNTIME_DATA_CLEANUP_PARTICIPANT),
      ]),
      RUNTIME_DATA_CLEANUP_PARTICIPANT,
    ];
    let participantId = "runtime-stop";

    project = await write({
      ...project,
      desiredState: "stopped",
      runtime: {
        driver: runtime.name,
        status: "stopping",
      },
      deletion: {
        status: "running",
        startedAt,
        updatedAt: new Date().toISOString(),
        participants: plannedParticipants,
        completedParticipants: [...completedParticipants],
        currentParticipant: participantId,
      },
      updatedAt: new Date().toISOString(),
    });

    try {
      const stopped = await runtime.stop(project.id);
      project = await write({
        ...applySnapshot(project, stopped),
        deletion: {
          status: "running",
          startedAt,
          updatedAt: new Date().toISOString(),
          participants: plannedParticipants,
          completedParticipants: [...completedParticipants],
        },
      });

      for (const plannedId of plannedParticipants) {
        if (
          !completedParticipants.has(plannedId) &&
          !cleanupParticipantIds.has(plannedId)
        ) {
          participantId = plannedId;
          throw new Error(
            `Required Project cleanup participant "${plannedId}" is unavailable.`,
          );
        }
      }

      for (const participant of cleanupParticipants) {
        if (completedParticipants.has(participant.id)) {
          continue;
        }
        participantId = participant.id;
        project = await write({
          ...project,
          deletion: {
            status: "running",
            startedAt,
            updatedAt: new Date().toISOString(),
            participants: plannedParticipants,
            completedParticipants: [...completedParticipants],
            currentParticipant: participant.id,
          },
          updatedAt: new Date().toISOString(),
        });
        await participant.cleanup(project);
        completedParticipants.add(participant.id);
        project = await write({
          ...project,
          deletion: {
            status: "running",
            startedAt,
            updatedAt: new Date().toISOString(),
            participants: plannedParticipants,
            completedParticipants: [...completedParticipants],
          },
          updatedAt: new Date().toISOString(),
        });
      }

      participantId = "project-record";
      const deleted = await store.delete(PROJECTS_NAMESPACE, project.id);
      if (!deleted && (await read(project.id))) {
        throw new Error("The Platform System Store did not delete the Project record.");
      }
      return true;
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failureSnapshot = await runtime.status(project.id).catch(() => ({
        status: project.runtime.status === "stopping"
          ? ("failed" as const)
          : project.runtime.status,
        ...(project.runtime.url ? { url: project.runtime.url } : {}),
        ...(project.runtime.startedAt
          ? { startedAt: project.runtime.startedAt }
          : {}),
        ...(project.runtime.stoppedAt
          ? { stoppedAt: project.runtime.stoppedAt }
          : {}),
      }));
      const failedProject: ZelavisProjectRecord = {
        ...project,
        desiredState: "stopped",
        runtime: {
          driver: runtime.name,
          ...failureSnapshot,
        },
        deletion: {
          status: "failed",
          startedAt,
          updatedAt: failedAt,
          participants: plannedParticipants,
          completedParticipants: [...completedParticipants],
          currentParticipant: participantId,
          error: error instanceof Error ? error.message : String(error),
        },
        updatedAt: failedAt,
      };
      await write(failedProject).catch(() => undefined);
      throw new ZelavisProjectDeletionError({
        projectId: project.id,
        participantId,
        cause: error,
      });
    }
  }

  const manager: ZelavisProjectManager = {
    runtime: {
      driver: runtime.name,
    },
    async list() {
      const records = await store.list(PROJECTS_NAMESPACE);
      const projects = await mapWithConcurrency(
        records,
        startupConcurrency,
        async (record) => {
          const { project, repaired } = normalizeStoredProject(record.value);
          if (repaired) {
            await write(project);
          }
          return refresh(project);
        },
      );
      return projects.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async get(id) {
      const project = await read(id);
      return project ? refresh(project) : undefined;
    },
    async create(input) {
      const name = normalizeProjectName(input.name);
      const id = normalizeProjectId(input.id ?? name);
      if (await read(id)) {
        throw new ZelavisProjectConflictError(`Project "${id}" already exists.`);
      }

      const appServiceName = input.appServiceName?.trim() || DEFAULT_APP_SERVICE_NAME;
      const appService = appServiceMap.get(appServiceName);
      if (!appService) {
        throw new ZelavisProjectValidationError(
          `App service "${appServiceName}" was not found.`,
        );
      }
      const app = appLockFromRegistryEntry(appService);
      const now = new Date().toISOString();
      const descriptor: ZelavisProjectDescriptor = {
        id,
        name,
        kind: projectKindFromAppService(app.name),
        app,
      };
      let project: ZelavisProjectRecord = {
        ...descriptor,
        capabilities: runtime.capabilities(descriptor),
        desiredState: input.start === false ? "stopped" : "running",
        runtime: {
          driver: runtime.name,
          status: "provisioning",
        },
        createdAt: now,
        updatedAt: now,
      };
      await write(project);

      try {
        await runtime.prepare(project, app);
        project = await write({
          ...project,
          runtime: { driver: runtime.name, status: "stopped" },
          updatedAt: new Date().toISOString(),
        });
        return input.start === false ? project : manager.start(id);
      } catch (error) {
        project = await write({
          ...project,
          desiredState: "stopped",
          runtime: {
            driver: runtime.name,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
    },
    async start(id) {
      let project = await requireProject(id);
      assertProjectIsOperable(project, "started");
      project = await write({
        ...project,
        desiredState: "running",
        runtime: { driver: runtime.name, status: "starting" },
        updatedAt: new Date().toISOString(),
      });

      try {
        await runtime.prepare(project, project.app);
        return write(applySnapshot(project, await runtime.start(project)));
      } catch (error) {
        const failed = {
          ...project,
          runtime: {
            driver: runtime.name,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          },
          updatedAt: new Date().toISOString(),
        };
        await write(failed);
        throw error;
      }
    },
    async stop(id) {
      let project = await requireProject(id);
      project = await write({
        ...project,
        desiredState: "stopped",
        runtime: { driver: runtime.name, status: "stopping" },
        updatedAt: new Date().toISOString(),
      });
      return write(applySnapshot(project, await runtime.stop(project.id)));
    },
    async restart(id) {
      let project = await requireProject(id);
      assertProjectIsOperable(project, "restarted");
      project = await write({
        ...project,
        desiredState: "running",
        runtime: { driver: runtime.name, status: "stopping" },
        updatedAt: new Date().toISOString(),
      });
      await runtime.stop(project.id);
      project = await write({
        ...project,
        runtime: { driver: runtime.name, status: "starting" },
        updatedAt: new Date().toISOString(),
      });

      try {
        await runtime.prepare(project, project.app);
        return write(applySnapshot(project, await runtime.start(project)));
      } catch (error) {
        const failed = {
          ...project,
          runtime: {
            driver: runtime.name,
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          },
          updatedAt: new Date().toISOString(),
        };
        await write(failed);
        throw error;
      }
    },
    async logs(id) {
      await requireProject(id);
      return runtime.logs(normalizeProjectId(id));
    },
    async remove(id) {
      const projectId = normalizeProjectId(id);
      const current = deletionPromises.get(projectId);
      if (current) return current;
      const deletion = deleteProject(projectId).finally(() => {
        deletionPromises.delete(projectId);
      });
      deletionPromises.set(projectId, deletion);
      return deletion;
    },
    reconcile() {
      reconciliationPromise ??= (async () => {
        const existing = await store.list(PROJECTS_NAMESPACE);
        await mapWithConcurrency(
          existing,
          startupConcurrency,
          async (record) => {
            if (closing) {
              return;
            }

            const { project, repaired } = normalizeStoredProject(record.value);
            if (repaired) {
              await write(project);
            }
            if (project.deletion) {
              await manager.remove(project.id).catch(() => undefined);
              return;
            }
            if (project.desiredState !== "running") {
              return;
            }
            const snapshot = await runtime.status(project.id);
            if (
              !closing &&
              snapshot.status !== "running" &&
              snapshot.status !== "starting"
            ) {
              await manager.start(project.id).catch(() => undefined);
            }
          },
        );
      })();
      return reconciliationPromise;
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        await reconciliationPromise?.catch(() => undefined);
        await runtime.close();
      })();
      return closePromise;
    },
  };

  void manager.reconcile();

  return manager;
}
