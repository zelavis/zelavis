import type {
  FabricPlacementPlan,
  FabricProjectPlacementRequest,
} from "./core/fabric/index.js";
import type {
  ZelavisProjectDriverCapabilities,
  ZelavisRuntimeService,
} from "./core/index.js";
import type {
  ZelavisProjectRuntimeKind,
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "./service.js";

export type { ZelavisProjectRuntimeKind } from "./service.js";
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

export interface ZelavisProjectRecipeLock {
  name: string;
  title: string;
  /** Exact recipe/runtime version. Platform upgrades must never rewrite this lock. */
  version: string;
  specifier: string;
  /** Runtime families allowed by this exact recipe lock. */
  runtimeKinds: readonly ZelavisProjectRuntimeKind[];
}

export interface ZelavisProjectDescriptor {
  id: string;
  name: string;
  kind: ZelavisProjectKind;
  recipe: ZelavisProjectRecipeLock;
  /** Explicit host runtime assignment. Never infer this from live processes. */
  runtimeKind: ZelavisProjectRuntimeKind;
  /**
   * Project that owns this one, when it is not owned by the Platform.
   *
   * A server frontend is a Project-shaped runtime — process, data directory,
   * lifecycle, logs, routed target — belonging to the Project it serves. That
   * ownership, not a display rule, is what makes it disappear from the
   * Platform's project list: an owned Project is deleted with its owner and
   * placed alongside it, because it is part of that Project rather than a peer
   * of it.
   */
  ownerProjectId?: string;
}

/**
 * Where a Project is placed, when that is not this host.
 *
 * Kept beside `runtime` rather than inside it because the driver owns runtime
 * state and reports it fresh on every read — a note written there is erased by
 * the next status poll. This is the Platform's own record of a decision the
 * Fabric made, and it is what answers "why is this Project not running".
 */
export interface ZelavisProjectPlacementState {
  /** The node the Fabric placed it on. */
  readonly nodeId: string;
  /** When this host handed it to that node, if it could. */
  readonly dispatchedAt?: string;
  /** Why it could not be handed over. */
  readonly error?: string;
}

export interface ZelavisProjectRecord extends ZelavisProjectDescriptor {
  capabilities: ZelavisProjectDriverCapabilities;
  desiredState: "running" | "stopped";
  runtime: ZelavisProjectRuntimeState;
  /** Set only while the Project belongs to a node this host is not. */
  placement?: ZelavisProjectPlacementState;
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
  /** Runtime families this configured driver can currently execute. */
  readonly runtimeKinds?: readonly ZelavisProjectRuntimeKind[];
  readonly defaultRuntimeKind?: ZelavisProjectRuntimeKind;
  readonly startupConcurrency?: number;
  capabilities(
    project: Readonly<ZelavisProjectDescriptor>,
  ): ZelavisProjectDriverCapabilities;
  prepare(
    project: ZelavisProjectRecord,
    recipe: ZelavisProjectRecipeLock,
  ): Promise<void>;
  start(project: ZelavisProjectRecord): Promise<ZelavisProjectRuntimeSnapshot>;
  stop(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  /**
   * Takes back Projects this host is still running.
   *
   * Called once by the host while it composes, before anything is reconciled.
   * A driver whose processes die with the Platform has nothing to adopt and
   * omits it; one running behind an Agent that outlived the Platform finds its
   * Projects still serving and takes them over rather than restarting them.
   *
   * Restarting is not a harmless alternative: it drops the connections the
   * Project is currently serving, and for a Project with a persisted port it
   * collides with the copy that is still listening.
   */
  adopt?(): Promise<void>;
  status(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  destroy(projectId: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Signs a Project Gateway authority envelope for a running runtime.
   *
   * Optional: a driver that cannot authenticate the Platform to its runtime
   * simply omits this, and the Gateway then forwards no authority at all
   * rather than an unauthenticated claim. Returns `undefined` when the Project
   * is not running.
   */
  signGatewayAuthority?(
    projectId: string,
    claims: ZelavisProjectGatewayAuthorityInput,
  ): Promise<string | undefined>;
}

/** Claims the Gateway supplies; the driver adds expiry and nonce when signing. */
export interface ZelavisProjectGatewayAuthorityInput {
  readonly projectId: string;
  readonly scopeId: string;
  readonly generation: number;
  readonly runtimeNodeId: string;
  readonly subject: string;
  readonly subjectType: string;
  readonly permissions: readonly string[];
}

export interface ZelavisProjectCreateInput {
  name: string;
  id?: string;
  recipeName?: string;
  start?: boolean;
  /**
   * Project that will own this one.
   *
   * The owner must already exist: an owned Project whose owner is missing
   * would never be cleaned up, because deletion reaches it through the owner.
   */
  ownerProjectId?: string;
}

export interface ZelavisProjectManager {
  readonly runtime: {
    driver: string;
    availableKinds: readonly ZelavisProjectRuntimeKind[];
  };
  /**
   * Projects the Platform owns.
   *
   * Project-owned runtimes — a server frontend, for example — are excluded:
   * they belong to the Project that owns them, not to the Platform, and appear
   * through that Project rather than beside it. Pass `includeOwned` to see the
   * complete set, which is what deletion and reconciliation need.
   */
  list(options?: { includeOwned?: boolean }): Promise<readonly ZelavisProjectRecord[]>;
  /** Projects owned by one Project. */
  listOwned(ownerProjectId: string): Promise<readonly ZelavisProjectRecord[]>;
  get(id: string): Promise<ZelavisProjectRecord | undefined>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  start(id: string): Promise<ZelavisProjectRecord>;
  stop(id: string): Promise<ZelavisProjectRecord>;
  restart(id: string): Promise<ZelavisProjectRecord>;
  logs(id: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(id: string): Promise<boolean>;
  /** See `ZelavisProjectRuntimeDriver.signGatewayAuthority`. */
  signGatewayAuthority(
    projectId: string,
    claims: ZelavisProjectGatewayAuthorityInput,
  ): Promise<string | undefined>;
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

/** A caller-actionable failure while preparing or running a Project runtime. */
export class ZelavisProjectRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZelavisProjectRuntimeError";
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
const DEFAULT_PROJECT_RECIPE_NAME = "zelavis/app";
const DEFAULT_STARTUP_CONCURRENCY = 1;
const DEFAULT_RUNTIME_KIND: ZelavisProjectRuntimeKind = "native";
const OWNED_PROJECTS_CLEANUP_PARTICIPANT = "owned-projects";
const RUNTIME_DATA_CLEANUP_PARTICIPANT = "runtime-data";
const RETIRED_OFFICIAL_RECIPE_LOCKS = new Map([
  ["@zelavis/app", DEFAULT_PROJECT_RECIPE_NAME],
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

/** Longest accepted raw Project identifier before normalization. */
const MAX_PROJECT_ID_INPUT_LENGTH = 256;

function normalizeProjectId(value: string): string {
  if (value.length > MAX_PROJECT_ID_INPUT_LENGTH) {
    throw new ZelavisProjectValidationError(
      `Project id must not exceed ${MAX_PROJECT_ID_INPUT_LENGTH} characters.`,
    );
  }

  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Trim separators by scanning rather than with `/^-+|-+$/`: that alternation
  // backtracks quadratically on a long run of separators, and this value comes
  // from request input.
  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  const normalized = slug.slice(start, end);

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

function projectKindFromRecipe(recipeName: string): ZelavisProjectKind {
  if (recipeName === "zelavis/app") {
    return "zelavis";
  }

  return recipeName
    .replace(/^@/, "")
    .replace(/^zelavis\//, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "generic";
}

function recipeTitleFromService(
  service: Readonly<ZelavisRuntimeService<any> & { marketplace?: { title?: string } }>,
) {
  return service.marketplace?.title ?? service.menu?.title ?? service.name;
}

function recipeLockFromRegistryEntry(
  entry: Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>,
): ZelavisProjectRecipeLock {
  if (!entry.service.version) {
    throw new ZelavisProjectValidationError(
      `Project recipe "${entry.service.name}" must declare an exact version.`,
    );
  }

  return {
    name: entry.service.name,
    title: recipeTitleFromService(entry.service),
    version: entry.service.version,
    specifier: entry.specifier ?? entry.service.name,
    runtimeKinds: normalizeRecipeRuntimeKinds(entry.service.project?.runtimeKinds),
  };
}

function normalizeRuntimeKind(value: unknown): ZelavisProjectRuntimeKind {
  if (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
  ) {
    return value;
  }
  throw new ZelavisProjectValidationError(
    "Project runtime kind must be a lowercase backend slug of at most 64 characters.",
  );
}

function normalizeRecipeRuntimeKinds(
  values: readonly ZelavisProjectRuntimeKind[] | undefined,
): readonly ZelavisProjectRuntimeKind[] {
  const normalized = [...new Set((values ?? [DEFAULT_RUNTIME_KIND]).map(normalizeRuntimeKind))];
  if (normalized.length === 0) {
    throw new ZelavisProjectValidationError(
      "A Project recipe must support at least one Project runtime kind.",
    );
  }
  return Object.freeze(normalized);
}

function readStoredRecipeLock(rawProject: Record<string, unknown>): ZelavisProjectRecipeLock {
  // `app` was the pre-recipe field name. Reading it here is a one-time stored
  // data migration; repaired records are immediately rewritten with `recipe`.
  const rawRecipe = rawProject.recipe ?? rawProject.app;
  if (!isObjectRecord(rawRecipe)) {
    throw new ZelavisProjectValidationError(
      "Stored project record is missing its Project recipe lock.",
    );
  }

  const fields = ["name", "title", "version", "specifier"] as const;
  for (const field of fields) {
    if (typeof rawRecipe[field] !== "string" || rawRecipe[field].trim().length === 0) {
      throw new ZelavisProjectValidationError(
        `Stored Project recipe ${field} must be a non-empty string.`,
      );
    }
  }

  return {
    name: rawRecipe.name as string,
    title: rawRecipe.title as string,
    version: rawRecipe.version as string,
    specifier: rawRecipe.specifier as string,
    runtimeKinds: normalizeRecipeRuntimeKinds(
      Array.isArray(rawRecipe.runtimeKinds)
        ? rawRecipe.runtimeKinds as ZelavisProjectRuntimeKind[]
        : undefined,
    ),
  };
}

/**
 * What reconciliation needs from Fabric to honour placement groups.
 *
 * Deliberately narrow. Reconciliation does not schedule: the local runtime
 * driver runs every Project on this host, so an assigned node is not something
 * it can act on. What it can do is refuse to start a Project whose placement
 * group cannot be satisfied, which is the part that would otherwise be silently
 * violated.
 */
export interface ZelavisProjectPlacementAuthority {
  planProjectPlacements(
    requests: readonly FabricProjectPlacementRequest[],
  ): Promise<FabricPlacementPlan>;
}

/**
 * Runs a Project on a node this host is not.
 *
 * Placement is only authoritative if a Project placed elsewhere actually goes
 * elsewhere. Without a dispatcher, a Project the planner assigned to another
 * node is left stopped and says so — which is a worse outcome than running it,
 * and the correct one: running it here would silently contradict the placement
 * the Fabric decided, and two hosts each deciding that would run it twice.
 */
export interface ZelavisProjectDispatcher {
  /** The node whose work this host executes itself. */
  readonly localNodeId: string;
  /**
   * Hands a Project's start to the node that owns it.
   *
   * Optional: an installation that knows its node id but has no way to reach
   * the others still gets the refusal above, which is the part that keeps
   * placement honest. Implementing this is the Agent execution path.
   */
  dispatchStart?(request: {
    readonly projectId: string;
    readonly nodeId: string;
  }): Promise<void>;
}

/**
 * Placement failures that reconciliation acts on.
 *
 * Only ownership. A Project reported unplaced for capacity or node eligibility
 * is a scheduling answer, and this host does not schedule — treating it as a
 * refusal would stop Projects from starting on a single-node installation that
 * models no capacity at all. An ownership failure is different: it says the
 * group is unsatisfiable no matter which node runs it.
 */
const BLOCKING_PLACEMENT_REASONS = new Set(["owner-unplaced", "owner-cycle"]);

export async function createProjectManager(options: {
  store: ZelavisSystemStore;
  projectRecipes: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  runtime: ZelavisProjectRuntimeDriver;
  resolveDefaultRuntimeKind?: () => Promise<ZelavisProjectRuntimeKind>;
  cleanupParticipants?: readonly ZelavisProjectCleanupParticipant[];
  /**
   * Resolved lazily because Fabric is composed after the Project manager, and
   * absent on a host with no Fabric — which reconciles exactly as it did
   * before.
   */
  placement?: () => ZelavisProjectPlacementAuthority | undefined;
  /**
   * Which node this host is, and how to reach the others.
   *
   * Resolved lazily for the same reason as `placement`. Absent on a host that
   * models no nodes at all, which starts everything locally exactly as before.
   */
  dispatch?: () => ZelavisProjectDispatcher | undefined;
  /**
   * Whether to reconcile as soon as the manager exists.
   *
   * A host that supplies `placement` must set this false and reconcile once
   * composition finishes. Reconciliation runs once per manager, so a startup
   * pass that fires before Fabric exists is not a late arrival — it is the only
   * pass, and it would enforce nothing.
   */
  autoReconcile?: boolean;
}): Promise<ZelavisProjectManager> {
  const { store, projectRecipes, runtime } = options;
  const availableRuntimeKinds = normalizeRecipeRuntimeKinds(runtime.runtimeKinds);
  const defaultRuntimeKind = normalizeRuntimeKind(
    runtime.defaultRuntimeKind ?? availableRuntimeKinds[0] ?? DEFAULT_RUNTIME_KIND,
  );
  if (!availableRuntimeKinds.includes(defaultRuntimeKind)) {
    throw new ZelavisProjectValidationError(
      `Default Project runtime kind "${defaultRuntimeKind}" is not available from driver "${runtime.name}".`,
    );
  }
  const startupConcurrency = normalizeConcurrency(runtime.startupConcurrency);
  let closing = false;
  let reconciliationPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const deletionPromises = new Map<string, Promise<boolean>>();
  const cleanupParticipants = [
    // Owned Projects go before the host-supplied participants: a Project's own
    // runtime data must outlive the things that depend on it until they are
    // gone, and an owned runtime is only removable while its owner still
    // exists to describe it.
    {
      id: OWNED_PROJECTS_CLEANUP_PARTICIPANT,
      cleanup: async (project: Readonly<ZelavisProjectRecord>) => {
        const owned = await manager.listOwned(project.id);
        // Sequential, not concurrent: each removal is itself a durable,
        // resumable lifecycle, and a partial failure must leave a state the
        // next reconciliation can continue from.
        for (const child of owned) {
          await manager.remove(child.id);
        }
      },
    },
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

  // Frontends are recipes too. A frontend is a Project like any other — it
  // gets a directory, a lifecycle, logs, and a routed target — and differs only
  // in what it runs and in being owned by the Project it fronts. Excluding it
  // here is what made an installed frontend package unselectable.
  const projectRecipeMap = new Map(
    projectRecipes
      .filter(
        (entry) =>
          entry.service.kind === "app" || entry.service.kind === "frontend",
      )
      .map((entry) => [entry.service.name, entry]),
  );

  /**
   * The Project kind a recipe produces.
   *
   * A frontend recipe always produces a `frontend` Project, whatever the
   * package is called: the runtime driver routes on that kind to decide whether
   * to run a frontend process, so deriving it from the package name would send
   * `@acme/theme` to the Zelavis runner.
   */
  function projectKindForRecipe(recipeName: string): ZelavisProjectKind {
    return projectRecipeMap.get(recipeName)?.service.kind === "frontend"
      ? "frontend"
      : projectKindFromRecipe(recipeName);
  }

  function normalizeStoredProject(value: ZelavisSystemStoreValue): {
    project: ZelavisProjectRecord;
    repaired: boolean;
  } {
    const rawProject = parseStoredProject(value);
    const rawRecord = rawProject as unknown as Record<string, unknown>;
    const storedRecipe = readStoredRecipeLock(rawRecord);
    const deletion = readStoredDeletionState(rawRecord);
    const replacementName =
      RETIRED_OFFICIAL_RECIPE_LOCKS.get(storedRecipe.name) ??
      RETIRED_OFFICIAL_RECIPE_LOCKS.get(storedRecipe.specifier);
    const replacement = replacementName
      ? projectRecipeMap.get(replacementName)
      : undefined;
    const recipe = replacement
      ? {
          ...storedRecipe,
          name: replacement.service.name,
          title: recipeTitleFromService(replacement.service),
          specifier: replacement.specifier ?? replacement.service.name,
        }
      : storedRecipe;
    const storedOwner =
      typeof (rawProject as { ownerProjectId?: unknown }).ownerProjectId === "string"
        ? ((rawProject as { ownerProjectId: string }).ownerProjectId)
        : undefined;
    const descriptor: ZelavisProjectDescriptor = {
      id: rawProject.id,
      name: rawProject.name,
      kind: rawProject.kind || projectKindForRecipe(recipe.name),
      recipe,
      // Ownership must survive a restart. Dropping it here would orphan every
      // owned runtime, because deletion reaches them through their owner.
      ...(storedOwner ? { ownerProjectId: storedOwner } : {}),
      runtimeKind: rawRecord.runtimeKind === undefined
        ? DEFAULT_RUNTIME_KIND
        : normalizeRuntimeKind(rawRecord.runtimeKind),
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
      ...(rawProject.placement ? { placement: rawProject.placement } : {}),
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };

    return {
      project,
      repaired:
        JSON.stringify(rawRecord.recipe) !== JSON.stringify(recipe) ||
        rawRecord.app !== undefined ||
        rawRecord.runtimeKind !== project.runtimeKind ||
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

  /**
   * Serializes lifecycle transitions per Project.
   *
   * Start, stop, restart, and delete each read the record, mutate the child
   * process, and write the result back. Interleaving two of them lets a stale
   * write land after a newer one — starting a process during cleanup, or
   * leaving the System Store disagreeing with the actual child.
   *
   * This orders operations within one Platform process. Coordinating multiple
   * Platform writers additionally needs System Store compare-and-set on a
   * transition generation, which is tracked in `TODO.md`.
   */
  const lifecycleQueues = new Map<string, Promise<unknown>>();

  function withProjectLifecycle<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = lifecycleQueues.get(projectId) ?? Promise.resolve();
    // Run regardless of how the previous operation settled: one failure must
    // not wedge the queue for this Project.
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    lifecycleQueues.set(projectId, tail);
    void tail.then(() => {
      // Drop the entry only if nothing queued behind us, so the map does not
      // grow without bound.
      if (lifecycleQueues.get(projectId) === tail) {
        lifecycleQueues.delete(projectId);
      }
    });
    return result;
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

  /**
   * What the planner says about every desired-running Project.
   *
   * Every one is planned together, because an owned Project can only be judged
   * against an owner the planner can see — planning one at a time would report
   * every owner as absent and refuse everything.
   *
   * A host with no placement authority decides nothing here, which is how a
   * single-node installation behaves today and should keep behaving. So does a
   * planner that fails: the result is empty, and reconciliation starts what it
   * would have started anyway. Fabric being down is not a reason to leave an
   * installation stopped.
   */
  async function resolvePlacementDecisions(
    records: readonly { value: ZelavisSystemStoreValue }[],
    planOptions: { readonly alsoPlan?: string } = {},
  ): Promise<{
    /** Left stopped: no node may run it, whatever this host does. */
    readonly blocked: ReadonlySet<string>;
    /** Placed on another node, mapped to the node that owns it. */
    readonly elsewhere: ReadonlyMap<string, string>;
  }> {
    const empty = { blocked: new Set<string>(), elsewhere: new Map<string, string>() };
    const authority = options.placement?.();
    if (!authority) return empty;

    const requests: FabricProjectPlacementRequest[] = [];
    for (const record of records) {
      const { project } = normalizeStoredProject(record.value);
      if (project.deletion) continue;
      if (
        project.desiredState !== "running" &&
        project.id !== planOptions.alsoPlan
      ) {
        continue;
      }

      requests.push({
        identity: {
          scopeId: "platform",
          workloadId: project.id,
          type: "project",
        },
        projectKind: project.kind,
        capabilities: { statelessRuntimeReplicas: false },
        ...(project.ownerProjectId
          ? { ownerProjectId: project.ownerProjectId }
          : {}),
      });
    }

    const localNodeId = options.dispatch?.()?.localNodeId;

    // Nothing owns anything and this host does not know which node it is, so
    // there is no group to violate and no assignment to compare against.
    if (!localNodeId && !requests.some((request) => request.ownerProjectId)) {
      return empty;
    }

    const plan = await authority
      .planProjectPlacements(requests)
      .catch(() => undefined);
    if (!plan) return empty;

    const blocked = new Set<string>();
    for (const replica of plan.unplaced) {
      if (BLOCKING_PLACEMENT_REASONS.has(replica.reason)) {
        blocked.add(replica.identity.workloadId);
      }
    }

    const elsewhere = new Map<string, string>();
    if (localNodeId) {
      for (const replica of plan.replicas) {
        if (replica.runtimeNodeId !== localNodeId) {
          elsewhere.set(replica.identity.workloadId, replica.runtimeNodeId);
        }
      }
    }

    return { blocked, elsewhere };
  }

  /**
   * Starts a Project on this host.
   *
   * Split out from `start` so reconciliation, which has already planned every
   * Project together, does not re-plan the whole fleet once per Project it
   * starts.
   */
  async function startLocally(id: string): Promise<ZelavisProjectRecord> {
    let project = await requireProject(id);
    // Starting it here settles the question the note recorded, so the note
    // goes rather than lingering as a stale explanation of a state that has
    // changed.
    const { placement: _placedElsewhere, ...withoutPlacement } = project;
    project = await write({
      ...withoutPlacement,
      desiredState: "running",
      runtime: { driver: runtime.name, status: "starting" },
      updatedAt: new Date().toISOString(),
    });

    try {
      await runtime.prepare(project, project.recipe);
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
  }

  /**
   * The node one Project is placed on, when that node is not this host.
   *
   * Plans the whole fleet rather than the one Project, because an owned
   * Project is only placeable against an owner the planner can see.
   */
  async function resolveAssignedNodeElsewhere(
    projectId: string,
  ): Promise<string | undefined> {
    if (!options.dispatch?.()?.localNodeId) return undefined;
    const records = await store.list(PROJECTS_NAMESPACE);
    // Planned as though it were already desired-running: it is about to be,
    // and a Project that is currently stopped contributes no request, so
    // without this the answer would always be "placed here".
    const placement = await resolvePlacementDecisions(records, {
      alsoPlan: projectId,
    });
    return placement.elsewhere.get(projectId);
  }

  /**
   * Hands a Project to the node its placement names, or records why it could
   * not be.
   *
   * The refusal is the point. Running it here anyway would contradict the
   * placement the Fabric decided, and on a fleet where every host reconciles,
   * every host would reach the same conclusion and run its own copy. Leaving
   * it stopped with the node named is recoverable; two live copies of a
   * Project's data are not.
   */
  async function dispatchElsewhere(
    project: ZelavisProjectRecord,
    nodeId: string,
  ): Promise<void> {
    const dispatcher = options.dispatch?.();
    const now = new Date().toISOString();

    if (dispatcher?.dispatchStart) {
      try {
        await dispatcher.dispatchStart({ projectId: project.id, nodeId });
        await write({
          ...project,
          placement: { nodeId, dispatchedAt: now },
          updatedAt: now,
        }).catch(() => undefined);
        return;
      } catch (error) {
        await write({
          ...project,
          placement: {
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          },
          updatedAt: now,
        }).catch(() => undefined);
        return;
      }
    }

    // `desiredState` stays "running": the Project is not stopped by intent,
    // it is unstarted by this host, and a later reconcile with a dispatcher
    // configured — or a placement that names this node — starts it.
    await write({
      ...project,
      placement: {
        nodeId,
        error: `This host cannot start Projects on node "${nodeId}".`,
      },
      updatedAt: now,
    }).catch(() => undefined);

    const snapshot = await runtime.status(project.id);
    if (snapshot.status === "running" || snapshot.status === "starting") {
      // It is running here and no longer placed here. Stopping it is this
      // host's half of the move; the node that now owns it starts it. The
      // driver is asked directly rather than through `stop`, which would clear
      // `desiredState` and make the move look like an operator stopping it.
      await runtime.stop(project.id).catch(() => undefined);
    }
  }

  const manager: ZelavisProjectManager = {
    runtime: {
      driver: runtime.name,
      availableKinds: availableRuntimeKinds,
    },
    async list(options) {
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
      const visible = options?.includeOwned
        ? projects
        : projects.filter((project) => project.ownerProjectId === undefined);
      return visible.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    },
    async listOwned(ownerProjectId) {
      const owner = normalizeProjectId(ownerProjectId);
      const all = await manager.list({ includeOwned: true });
      return all.filter((project) => project.ownerProjectId === owner);
    },
    async get(id) {
      const project = await read(id);
      return project ? refresh(project) : undefined;
    },
    async create(input) {
      const name = normalizeProjectName(input.name);
      const id = normalizeProjectId(input.id ?? name);

      const recipeName = input.recipeName?.trim() || DEFAULT_PROJECT_RECIPE_NAME;
      const projectRecipe = projectRecipeMap.get(recipeName);
      if (!projectRecipe) {
        throw new ZelavisProjectValidationError(
          `Project recipe "${recipeName}" was not found.`,
        );
      }
      const recipe = recipeLockFromRegistryEntry(projectRecipe);
      const runtimeKind = normalizeRuntimeKind(
        options.resolveDefaultRuntimeKind
          ? await options.resolveDefaultRuntimeKind()
          : defaultRuntimeKind,
      );
      if (!recipe.runtimeKinds.includes(runtimeKind)) {
        throw new ZelavisProjectValidationError(
          `Project recipe "${recipe.name}" does not support the "${runtimeKind}" runtime. Supported runtimes: ${recipe.runtimeKinds.join(", ")}.`,
        );
      }
      if (!availableRuntimeKinds.includes(runtimeKind)) {
        throw new ZelavisProjectValidationError(
          `Project runtime "${runtimeKind}" is not available on this Zelavis server. Available runtimes: ${availableRuntimeKinds.join(", ")}.`,
        );
      }
      const now = new Date().toISOString();
      const ownerProjectId = input.ownerProjectId
        ? normalizeProjectId(input.ownerProjectId)
        : undefined;
      if (ownerProjectId) {
        if (ownerProjectId === id) {
          throw new ZelavisProjectValidationError(
            `Project "${id}" cannot own itself.`,
          );
        }
        const owner = await read(ownerProjectId);
        if (!owner) {
          throw new ZelavisProjectValidationError(
            `Owner Project "${ownerProjectId}" was not found.`,
          );
        }
        if (owner.ownerProjectId) {
          // One level only for now. Deeper nesting is the Project Cell model,
          // which needs placement grouping and resource accounting before it
          // can be safe.
          throw new ZelavisProjectValidationError(
            `Project "${ownerProjectId}" is itself owned, and nested ownership is not supported yet.`,
          );
        }
        if (owner.deletion) {
          throw new ZelavisProjectValidationError(
            `Owner Project "${ownerProjectId}" is being deleted.`,
          );
        }
      }

      const descriptor: ZelavisProjectDescriptor = {
        id,
        ...(ownerProjectId ? { ownerProjectId } : {}),
        name,
        kind: projectKindForRecipe(recipe.name),
        recipe,
        runtimeKind,
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
      // Claim the identifier atomically. A read-then-write check is a
      // time-of-check/time-of-use race: two concurrent creates both observe an
      // absent Project and both provision it.
      const claim = await store.setIfAbsent(
        PROJECTS_NAMESPACE,
        id,
        toStoreValue(project),
      );
      if (!claim.created) {
        throw new ZelavisProjectConflictError(`Project "${id}" already exists.`);
      }

      try {
        await runtime.prepare(project, recipe);
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
      return withProjectLifecycle(normalizeProjectId(id), async () => {
      const placed = await requireProject(id);
      assertProjectIsOperable(placed, "started");

      // An explicit start is still subject to placement. Told to run a Project
      // this host is not placed to run, saying so is the only answer that does
      // not quietly contradict the Fabric.
      const assignedNodeId = await resolveAssignedNodeElsewhere(placed.id);
      if (assignedNodeId !== undefined) {
        await dispatchElsewhere(placed, assignedNodeId);
        const dispatched = options.dispatch?.()?.dispatchStart !== undefined;
        if (!dispatched) {
          throw new ZelavisProjectValidationError(
            `Project "${placed.id}" is placed on node "${assignedNodeId}", which this host cannot start Projects on.`,
          );
        }
        return requireProject(id);
      }

      return startLocally(id);
      });
    },
    async stop(id) {
      return withProjectLifecycle(normalizeProjectId(id), async () => {
      let project = await requireProject(id);
      // Stopping a Project that is already being deleted would restart the
      // cleanup lifecycle's work behind it.
      assertProjectIsOperable(project, "stopped");
      project = await write({
        ...project,
        desiredState: "stopped",
        runtime: { driver: runtime.name, status: "stopping" },
        updatedAt: new Date().toISOString(),
      });
      return write(applySnapshot(project, await runtime.stop(project.id)));
      });
    },
    async restart(id) {
      return withProjectLifecycle(normalizeProjectId(id), async () => {
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
        await runtime.prepare(project, project.recipe);
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
      });
    },
    async logs(id) {
      await requireProject(id);
      return runtime.logs(normalizeProjectId(id));
    },
    async signGatewayAuthority(projectId, claims) {
      return runtime.signGatewayAuthority?.(
        normalizeProjectId(projectId),
        claims,
      );
    },
    async remove(id) {
      const projectId = normalizeProjectId(id);
      // Deletion is deduplicated so repeated calls join one cleanup, and it
      // shares the lifecycle queue so a concurrent start/stop cannot write the
      // record back after cleanup removed it.
      const current = deletionPromises.get(projectId);
      if (current) return current;
      const deletion = withProjectLifecycle(projectId, () =>
        deleteProject(projectId),
      ).finally(() => {
        deletionPromises.delete(projectId);
      });
      deletionPromises.set(projectId, deletion);
      return deletion;
    },
    reconcile() {
      reconciliationPromise ??= (async () => {
        const existing = await store.list(PROJECTS_NAMESPACE);
        const placement = await resolvePlacementDecisions(existing);
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
              // Adoption can hand back a Project the operator has since
              // stopped: it kept running because nothing was there to stop it,
              // and the Platform now has the handle it was missing. Leaving it
              // running would make "stopped" mean "stopped, unless it happened
              // to survive a crash".
              const running = await runtime.status(project.id);
              if (running.status === "running" || running.status === "starting") {
                // `stop` takes the lifecycle lock itself. Wrapping it here
                // deadlocks: the queue is per Project, and the outer entry
                // would wait for an inner one that cannot start until it
                // returns.
                await manager.stop(project.id).catch(() => undefined);
              }
              return;
            }
            if (placement.blocked.has(project.id)) {
              // Left stopped rather than started somewhere its placement group
              // does not permit. `desiredState` stays "running", so the next
              // reconcile starts it as soon as its owner can be placed.
              return;
            }

            const assignedNodeId = placement.elsewhere.get(project.id);
            if (assignedNodeId !== undefined) {
              await dispatchElsewhere(project, assignedNodeId);
              return;
            }
            const snapshot = await runtime.status(project.id);
            if (
              !closing &&
              snapshot.status !== "running" &&
              snapshot.status !== "starting"
            ) {
              // Placement was decided once for the whole fleet above, so this
              // starts locally rather than re-planning per Project — but it
              // still takes the Project's lifecycle lock. Reconciliation runs
              // concurrently with whatever an operator is doing, and a start
              // interleaved with another start or a stop leaves the System
              // Store describing a process that is not what is running.
              await withProjectLifecycle(project.id, () =>
                startLocally(project.id),
              ).catch(() => undefined);
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

  if (options.autoReconcile !== false) {
    void manager.reconcile();
  }

  return manager;
}
