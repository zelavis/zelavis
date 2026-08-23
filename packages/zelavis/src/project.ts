import type {
  ZelavisBlueprintEntry,
  ZelavisBlueprintRegistry,
} from "./blueprint.js";
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

export interface ZelavisProjectRecord {
  id: string;
  name: string;
  kind: "zelavis";
  blueprint: {
    id: string;
    version: string;
  };
  desiredState: "running" | "stopped";
  runtime: ZelavisProjectRuntimeState;
  createdAt: string;
  updatedAt: string;
}

export interface ZelavisProjectRuntimeCapabilities {
  secureIsolation: boolean;
  resourceLimits: boolean;
  persistentFilesystem: boolean;
  description: string;
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
  readonly capabilities: ZelavisProjectRuntimeCapabilities;
  prepare(
    project: ZelavisProjectRecord,
    blueprint: ZelavisBlueprintEntry,
  ): Promise<void>;
  start(project: ZelavisProjectRecord): Promise<ZelavisProjectRuntimeSnapshot>;
  stop(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  status(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  destroy(projectId: string): Promise<void>;
}

export interface ZelavisProjectCreateInput {
  name: string;
  id?: string;
  blueprintId?: string;
  blueprintVersion?: string;
  start?: boolean;
}

export interface ZelavisProjectManager {
  readonly runtime: {
    driver: string;
    capabilities: ZelavisProjectRuntimeCapabilities;
  };
  list(): Promise<readonly ZelavisProjectRecord[]>;
  get(id: string): Promise<ZelavisProjectRecord | undefined>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  start(id: string): Promise<ZelavisProjectRecord>;
  stop(id: string): Promise<ZelavisProjectRecord>;
  logs(id: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(id: string): Promise<boolean>;
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
const DEFAULT_BLUEPRINT_ID = "zelavis/app";

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

export async function createProjectManager(options: {
  store: ZelavisSystemStore;
  blueprints: ZelavisBlueprintRegistry;
  runtime: ZelavisProjectRuntimeDriver;
}): Promise<ZelavisProjectManager> {
  const { store, blueprints, runtime } = options;

  async function read(id: string): Promise<ZelavisProjectRecord | undefined> {
    const record = await store.get(PROJECTS_NAMESPACE, normalizeProjectId(id));
    return record ? parseStoredProject(record.value) : undefined;
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
      capabilities: runtime.capabilities,
    },
    async list() {
      const records = await store.list(PROJECTS_NAMESPACE);
      const projects = await Promise.all(
        records.map((record) => refresh(parseStoredProject(record.value))),
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

      const blueprintId = input.blueprintId?.trim() || DEFAULT_BLUEPRINT_ID;
      const blueprint = blueprints.get(blueprintId, input.blueprintVersion);
      if (!blueprint) {
        throw new ZelavisProjectValidationError(
          `Blueprint "${blueprintId}${input.blueprintVersion ? `@${input.blueprintVersion}` : ""}" was not found.`,
        );
      }
      if (blueprint.manifest.kind !== "zelavis-app") {
        throw new ZelavisProjectValidationError(
          "Only the Zelavis App blueprint can currently create projects.",
        );
      }

      const now = new Date().toISOString();
      let project: ZelavisProjectRecord = {
        id,
        name,
        kind: "zelavis",
        blueprint: {
          id: blueprint.manifest.id,
          version: blueprint.manifest.version,
        },
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
        await runtime.prepare(project, blueprint);
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
  };

  const existing = await store.list(PROJECTS_NAMESPACE);
  await Promise.all(
    existing.map(async (record) => {
      const project = parseStoredProject(record.value);
      if (project.desiredState !== "running") {
        return;
      }
      const snapshot = await runtime.status(project.id);
      if (snapshot.status !== "running" && snapshot.status !== "starting") {
        await manager.start(project.id).catch(() => undefined);
      }
    }),
  );

  return manager;
}
