import type { ZelavisProjectDriverCapabilities } from "@zelavis/server";
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

export type ZelavisProjectKind = string;

export interface ZelavisProjectApp {
  name: string;
  title: string;
  version?: string;
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
  createdAt: string;
  updatedAt: string;
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

const PROJECTS_NAMESPACE = "projects";
const DEFAULT_APP_SERVICE_NAME = "@zelavis/app";
const DEFAULT_STARTUP_CONCURRENCY = 1;

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
  if (serviceName === "@zelavis/app") {
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
  return {
    name: entry.service.name,
    title: appTitleFromService(entry.service),
    ...(entry.service.version ? { version: entry.service.version } : {}),
    specifier: entry.specifier ?? entry.service.name,
  };
}

export async function createProjectManager(options: {
  store: ZelavisSystemStore;
  appServices: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  runtime: ZelavisProjectRuntimeDriver;
}): Promise<ZelavisProjectManager> {
  const { store, appServices, runtime } = options;
  const startupConcurrency = normalizeConcurrency(runtime.startupConcurrency);
  let closing = false;
  let reconciliationPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const appServiceMap = new Map(
    appServices
      .filter((entry) => entry.service.kind === "app")
      .map((entry) => [entry.service.name, entry]),
  );

  function resolveAppLock(rawProject: Record<string, unknown>): {
    app: ZelavisProjectApp;
    repaired: boolean;
  } {
    const rawApp = rawProject.app;
    const rawBlueprint = rawProject.blueprint;
    const appName =
      isObjectRecord(rawApp) && typeof rawApp.name === "string" && rawApp.name
        ? rawApp.name
        : isObjectRecord(rawBlueprint) && rawBlueprint.id === "zelavis/app"
          ? DEFAULT_APP_SERVICE_NAME
        : rawProject.kind === "zelavis"
          ? DEFAULT_APP_SERVICE_NAME
          : undefined;

    if (!appName) {
      throw new ZelavisProjectValidationError(
        "Stored project record is missing its app service lock.",
      );
    }

    const appService = appServiceMap.get(appName);
    if (!appService) {
      throw new ZelavisProjectValidationError(
        `App service "${appName}" was not found.`,
      );
    }

    const app = appLockFromRegistryEntry(appService);
    if (
      isObjectRecord(rawApp) &&
      rawApp.name === app.name &&
      rawApp.title === app.title &&
      rawApp.version === app.version &&
      rawApp.specifier === app.specifier
    ) {
      return { app, repaired: false };
    }

    return { app, repaired: true };
  }

  function normalizeStoredProject(value: ZelavisSystemStoreValue): {
    project: ZelavisProjectRecord;
    repaired: boolean;
  } {
    const rawProject = parseStoredProject(value);
    const rawRecord = rawProject as unknown as Record<string, unknown>;
    const { app, repaired: repairedApp } = resolveAppLock(rawRecord);
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
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };

    return {
      project,
      repaired:
        repairedApp ||
        rawProject.kind !== project.kind ||
        JSON.stringify(rawRecord.capabilities) !==
          JSON.stringify(capabilities) ||
        "blueprint" in rawRecord ||
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

  async function refresh(project: ZelavisProjectRecord): Promise<ZelavisProjectRecord> {
    if (project.runtime.status === "provisioning") {
      return project;
    }

    const snapshot = await runtime.status(project.id);
    const unchanged =
      snapshot.status === project.runtime.status &&
      snapshot.url === project.runtime.url &&
      snapshot.error === project.runtime.error;
    return unchanged ? project : write(applySnapshot(project, snapshot));
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
      const project = await read(id);
      if (!project) {
        return false;
      }
      await runtime.stop(project.id);
      await runtime.destroy(project.id);
      return store.delete(PROJECTS_NAMESPACE, project.id);
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
