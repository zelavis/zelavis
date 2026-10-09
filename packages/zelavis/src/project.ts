import { selectRecipeMethod, selectRecipeSoftware } from "./core/recipe/index.js";
import type { TaggedFailure } from "./core/runtime/effect-boundary.js";
import { isExactVersion } from "./updates.js";
import type { RuntimeRelease } from "./core/runtime/handover.js";
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { IntegrationFailure, effectOperations, unwrapFailure, evaluate, integration, lifecycleGate, present, presentOperations, singleFlight, type EffectOperations } from "./core/runtime/effect-boundary.js";
import type { ZelavisSystemStoreRecord } from "./system-store.js";
import { normalizeProjectHostPackages } from "./project-host-packages.js";
import type { ZelavisProjectPreview } from "./edge/previews.js";
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
  ZelavisProjectRecipeDefinition,
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "./service.js";

export type { ZelavisProjectRuntimeKind } from "./service.js";
import type { ZelavisDeploymentBackendCapabilities } from "./backends/registry.js";
import {
  assessProjectIsolation,
  normalizeProjectIsolationIntent,
  type ZelavisProjectIsolationAssessment,
  type ZelavisProjectIsolationIntent,
} from "./project-isolation.js";
export * from "./project-isolation.js";
import { normalizeProjectManaged, type ZelavisProjectManagedDefinition } from "./project-managed.js";
export { normalizeProjectManaged };
export type { ZelavisProjectManagedDefinition } from "./project-managed.js";
import type {
  ZelavisSystemStore,
  ZelavisSystemStoreValue,
} from "./system-store.js";
import type {
  ProjectPlacementAuthority,
  ProjectPlacementRecord,
  ProjectPlacementToken,
} from "./platform/project-placement-authority.js";

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

export interface ZelavisProjectInstallLock {
  /** The recipe's method id, for example `native` or `container`. */
  readonly method: string;
  readonly driver: "js" | "oci";
  /** The requirements the method declared, kept so start can check them without the manifest. */
  readonly requires: readonly string[];
  /** The exact software version this Project installs. */
  readonly software: string;
}

/** What this host can do for a recipe's install methods. */
export interface ZelavisProjectInstallHost {
  readonly drivers: readonly ("js" | "oci")[];
  /** Requirement names the host satisfies or can provision through approved operations. */
  readonly requirements: readonly string[];
}

export interface ZelavisProjectRecipeLock {
  hostPackages?: readonly string[];
  name: string;
  title: string;
  /** Exact recipe/runtime version. Platform upgrades must never rewrite this lock. */
  version: string;
  specifier: string;
  /** Runtime families allowed by this exact recipe lock. */
  runtimeKinds: readonly ZelavisProjectRuntimeKind[];
  /** Isolation declared by this exact recipe version, locked with it. */
  isolation?: ZelavisProjectIsolationIntent;
  /** Set for a managed app: hosting-style controls and its own admin entry. */
  managed?: ZelavisProjectManagedDefinition;
  /**
   * The install method and software version chosen at creation. Selection happens once and is
   * never repeated at start, so a host that loses the method refuses to start the Project
   * instead of quietly using another one.
   */
  install?: ZelavisProjectInstallLock;
  /**
   * Content digest of the recipe package materialized into the Project. A
   * runtime that finds one runs that artifact, not the Platform's copy.
   */
  artifact?: { digest: string };
}

export interface ZelavisProjectDescriptor {
  id: string;
  name: string;
  kind: ZelavisProjectKind;
  recipe: ZelavisProjectRecipeLock;
  /** Explicit engine selection. The driver locks and verifies its complete artifact. */
  engineVersion?: string;
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

/**
 * How a Project's locked recipe compares with what this Platform ships.
 * Derived on every read, never stored as authority.
 */
export type ZelavisProjectRecipeStatus =
  | { readonly state: "current" }
  /** This Platform ships another version of the same recipe. */
  | { readonly state: "upgradeAvailable"; readonly version: string }
  /** This Platform ships no recipe by the locked name, so an upgrade must name one. */
  | { readonly state: "unavailable"; readonly reason: string };

/** One completed recipe upgrade, kept so a Project's history is not a mystery. */
export interface ZelavisProjectRecipeUpgrade {
  readonly from: { readonly name: string; readonly version: string };
  readonly upgradedAt: string;
}

export interface ZelavisProjectRecord extends ZelavisProjectDescriptor {
  /** Derived Edge ingress state, never the Agent's private runtime target. */
  preview?: ZelavisProjectPreview;
  capabilities: ZelavisProjectDriverCapabilities;
  /** Whether a newer recipe is available for this Project. Derived on every read. */
  recipeStatus?: ZelavisProjectRecipeStatus;
  /** Recipe upgrades this Project has been through, oldest first, most recent ten. */
  recipeHistory?: readonly ZelavisProjectRecipeUpgrade[];
  /**
   * The locked isolation intent compared with the assigned backend, present
   * only when the recipe declares intent. Derived on every read, like
   * `capabilities`, because backend capability can change under a lock.
   */
  isolation?: ZelavisProjectIsolationAssessment;
  desiredState: "running" | "stopped";
  runtime: ZelavisProjectRuntimeState;
  /** Set only while the Project belongs to a node this host is not. */
  placement?: ZelavisProjectPlacementState;
  deletion?: ZelavisProjectDeletionState;
  /** Durable unfinished handover, recovered before another lifecycle action. */
  runtimeUpdate?: ZelavisProjectRuntimeUpdateIntent;
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

/** Prepared immutable identities, separate from the persisted Project lock. */
export interface ZelavisProjectRuntimeUpdate {
  /** Engine handover or a recipe integration refresh which leaves the workload alone. */
  readonly mode: "engine" | "integration" | "recipe";
  /** A running Project-scoped integration host participates in this transaction. */
  readonly host?: true;
  readonly previous: RuntimeRelease;
  readonly target: RuntimeRelease;
  readonly recipe: ZelavisProjectRecipeLock;
}

export interface ZelavisProjectRuntimeUpdateIntent {
  readonly id: string;
  readonly startedAt: string;
  readonly execution: ZelavisProjectRuntimeUpdate;
  readonly previous: Pick<ZelavisProjectRecord, "kind" | "recipe" | "recipeHistory" | "engineVersion">;
  readonly target: Pick<ZelavisProjectRecord, "kind" | "recipe" | "recipeHistory" | "engineVersion">;
  readonly error?: string;
}

export interface ZelavisProjectLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface ZelavisProjectVersions {
  readonly current?: string;
  readonly latest?: string;
  readonly selectable: boolean;
  readonly reason?: string;
  readonly versions: readonly { readonly version: string; readonly status: "available" | "unavailable"; readonly error?: string; readonly nodeVersion?: string }[];
}

export interface ZelavisProjectRuntimeDriver {
  readonly name: string;
  /** Runtime families this configured driver can currently execute. */
  readonly runtimeKinds?: readonly ZelavisProjectRuntimeKind[];
  readonly defaultRuntimeKind?: ZelavisProjectRuntimeKind;
  readonly startupConcurrency?: number;
  /** Trusted persistent host custody; never supplied by a Project or HTTP caller. */
  readonly custody?: { readonly ownerSession: string; readonly preserveOnClose: () => boolean };
  /** A qualified local handover for this exact Project, never a stop/start alias. */
  supportsLiveUpdate?(project: Readonly<ZelavisProjectDescriptor>): boolean;
  versions?(project?: Readonly<ZelavisProjectDescriptor>): Promise<ZelavisProjectVersions>;
  /** Resolves only a verified installed engine and its bundled App recipe. */
  resolveVersion?(project: Readonly<ZelavisProjectDescriptor>, version?: string): Promise<{ engineVersion: string; recipe: ZelavisProjectRecipeLock } | undefined>;
  prepareUpdate?(previous: ZelavisProjectRecord, candidate: ZelavisProjectRecord, placement?: ProjectPlacementToken): Promise<ZelavisProjectRuntimeUpdate>;
  applyUpdate?(projectId: string, update: ZelavisProjectRuntimeUpdate,
    commit: (selection: "previous" | "target") => Promise<void>): Promise<ZelavisProjectRuntimeSnapshot>;
  recoverUpdate?(projectId: string, update: ZelavisProjectRuntimeUpdate): Promise<"previous" | "target">;
  gatewayTarget?(project: ZelavisProjectRecord, placement?: ProjectPlacementToken): Promise<string | undefined>;
  /** Metadata of the exact digest-verified frozen recipe, independent of catalogue summaries. */
  recipeDefinition?(project: Readonly<ZelavisProjectDescriptor>): ZelavisProjectRecipeDefinition | undefined;
  capabilities(
    project: Readonly<ZelavisProjectDescriptor>,
  ): ZelavisProjectDriverCapabilities;
  prepare(
    project: ZelavisProjectRecord,
    recipe: ZelavisProjectRecipeLock,
  ): Promise<void>;
  start(
    project: ZelavisProjectRecord,
    placement?: ProjectPlacementToken,
  ): Promise<ZelavisProjectRuntimeSnapshot>;
  stop(projectId: string): Promise<ZelavisProjectRuntimeSnapshot>;
  /** Destination proof required before taking over an expired owner. */
  fencePrevious?(placement: ProjectPlacementToken): Promise<boolean>;
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
  /** Relinquish Agent handles while independently supervised workloads keep serving. */
  detach?(): Promise<void>;
  /**
   * The upgrade this driver prepared is recorded; whatever it kept to be able to go back
   * (an earlier layout's state) can be let go. Best effort: a driver that misses it settles at
   * the next start.
   */
  commitUpgrade?(projectId: string): Promise<void>;
  /** The upgrade was not recorded: put the Project's files back as the earlier recipe left them. */
  abandonUpgrade?(projectId: string): Promise<void>;
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
  /** The App Tenant the Platform resolved for this caller. */
  readonly tenantId: string;
  readonly permissions: readonly string[];
}

export interface ZelavisProjectCreateInput {
  engineVersion?: string;
  /** Install method id, for a recipe that offers several. Refused when this host cannot run it. */
  method?: string;
  /** Software version to install, for a recipe that offers several. Defaults to the newest. */
  softwareVersion?: string;
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

export interface ZelavisProjectUpdateInput {
  /** Human-readable label. Project identity and runtime placement do not change. */
  name: string;
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
  versions(id?: string): Promise<ZelavisProjectVersions>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  update(id: string, input: ZelavisProjectUpdateInput): Promise<ZelavisProjectRecord>;
  start(id: string): Promise<ZelavisProjectRecord>;
  stop(id: string): Promise<ZelavisProjectRecord>;
  restart(id: string): Promise<ZelavisProjectRecord>;
  /**
   * Selects a qualified App engine and its matching recipe, or upgrades another
   * Project recipe. Qualified running Apps hand over without changing their
   * ingress address; other Projects must be stopped or failed. Data stays in place.
   */
  /**
   * `restart`: a running Project whose upgrade cannot be done live is stopped first and started
   * again afterwards (it is started again even when the upgrade fails, as the recipe it had).
   * Without it, such an upgrade is refused until the Project is stopped.
   */
  upgrade(id: string, input?: { recipeName?: string; engineVersion?: string; restart?: boolean }): Promise<ZelavisProjectRecord>;
  switchVersion(id: string, version: string): Promise<ZelavisProjectRecord>;
  logs(id: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(id: string): Promise<boolean>;
  /** See `ZelavisProjectRuntimeDriver.signGatewayAuthority`. */
  gatewayTarget?(projectId: string): Promise<string | undefined>;
  signGatewayAuthority(
    projectId: string,
    claims: ZelavisProjectGatewayAuthorityInput,
  ): Promise<string | undefined>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export class ZelavisProjectValidationError extends Error {
  readonly _tag = "ZelavisProjectValidationError" as const;
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectValidationError";
  }
}

export class ZelavisProjectConflictError extends Error {
  readonly _tag = "ZelavisProjectConflictError" as const;
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectConflictError";
  }
}

export class ZelavisProjectNotFoundError extends Error {
  readonly _tag = "ZelavisProjectNotFoundError" as const;
  constructor(message: string) {
    super(message);
    this.name = "ZelavisProjectNotFoundError";
  }
}

/**
 * A recipe's required isolation cannot be proven by the assigned backend.
 *
 * A conflict with server policy rather than bad input: the same request can
 * succeed once an administrator makes a backend that satisfies it the default.
 */
export class ZelavisProjectIsolationError extends ZelavisProjectConflictError {
  readonly assessment: ZelavisProjectIsolationAssessment;

  constructor(projectLabel: string, assessment: ZelavisProjectIsolationAssessment) {
    const unmet = assessment.shortfalls
      .filter((shortfall) => shortfall.enforcement === "required")
      .map((shortfall) => `${shortfall.requirement} (needs ${shortfall.expected}, backend has ${shortfall.actual})`);
    super(
      `${projectLabel} requires isolation the "${assessment.runtimeKind}" deployment backend does not provide: ${unmet.join(", ")}. Zelavis refuses rather than running it with weaker isolation.`,
    );
    this.name = "ZelavisProjectIsolationError";
    this.assessment = assessment;
  }
}

/** A caller-actionable failure while preparing or running a Project runtime. */
export class ZelavisProjectRuntimeError extends Error {
  readonly _tag = "ZelavisProjectRuntimeError" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZelavisProjectRuntimeError";
  }
}

export class ZelavisProjectDeletionError extends Error {
  readonly _tag = "ZelavisProjectDeletionError" as const;
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
const DEFAULT_PROJECT_RECIPE_NAME = "@zelavis/app";
const DEFAULT_STARTUP_CONCURRENCY = 1;
const DEFAULT_RUNTIME_KIND: ZelavisProjectRuntimeKind = "native";
const OWNED_PROJECTS_CLEANUP_PARTICIPANT = "owned-projects";
const RUNTIME_DATA_CLEANUP_PARTICIPANT = "runtime-data";

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_STARTUP_CONCURRENCY;
  }

  return Math.max(1, Math.floor(value));
}

function mapWithConcurrency<TValue, TResult>(values: readonly TValue[], concurrency: number, map: (value: TValue, index: number) => Effect.Effect<TResult, TaggedFailure>): Effect.Effect<TResult[], TaggedFailure> {
    return Effect.forEach(values, map, { concurrency });
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
  if (recipeName === "@zelavis/app") {
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
    ...(entry.service.project?.hostPackages ? { hostPackages: normalizeProjectHostPackages(entry.service.project.hostPackages) } : {}),
    ...isolationIntentField(
      entry.service.project?.isolation,
      `Project recipe "${entry.service.name}"`,
    ),
    ...managedField(entry.service.project?.managed, `Project recipe "${entry.service.name}"`),
  };
}

function managedField(
  value: unknown,
  label: string,
): { managed?: ZelavisProjectManagedDefinition } {
  try {
    const managed = normalizeProjectManaged(value);
    return managed ? { managed } : {};
  } catch (error) {
    throw new ZelavisProjectValidationError(
      `${label} declares invalid managed metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isolationIntentField(
  value: unknown,
  label: string,
): { isolation?: ZelavisProjectIsolationIntent } {
  try {
    const isolation = normalizeProjectIsolationIntent(value);
    return isolation ? { isolation } : {};
  } catch (error) {
    throw new ZelavisProjectValidationError(
      `${label} declares invalid isolation intent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

const INSTALL_ID = /^[a-z][a-z0-9-]{0,63}$/;
const INSTALL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

function readInstallLock(value: unknown): ZelavisProjectInstallLock {
  const fail = () => new ZelavisProjectValidationError("Stored Project install lock is malformed.");
  if (!isObjectRecord(value)) throw fail();
  const { method, driver, requires, software, ...extra } = value;
  if (Object.keys(extra).length > 0 || typeof method !== "string" || !INSTALL_ID.test(method) ||
      (driver !== "js" && driver !== "oci") || typeof software !== "string" || software.length > 64 || !INSTALL_VERSION.test(software) ||
      !Array.isArray(requires) || requires.length > 32 || requires.some((name) => typeof name !== "string" || !INSTALL_ID.test(name))) {
    throw fail();
  }
  return Object.freeze({ method, driver, requires: Object.freeze([...requires] as string[]), software });
}

function readStoredRecipeLock(rawProject: Record<string, unknown>): ZelavisProjectRecipeLock {
  const rawRecipe = rawProject.recipe;
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
    ...isolationIntentField(rawRecipe.isolation, "Stored Project recipe lock"),
    ...managedField(rawRecipe.managed, "Stored Project recipe lock"),
    ...(rawRecipe.install !== undefined ? { install: readInstallLock(rawRecipe.install) } : {}),
    ...(rawRecipe.hostPackages !== undefined ? { hostPackages: normalizeProjectHostPackages(rawRecipe.hostPackages) } : {}),
    ...(rawRecipe.artifact !== undefined ? { artifact: (() => {
      if (!isObjectRecord(rawRecipe.artifact) || typeof rawRecipe.artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(rawRecipe.artifact.digest)) throw new ZelavisProjectValidationError("Stored recipe artifact requires its exact content digest.");
      return { digest: rawRecipe.artifact.digest };
    })() } : {}),
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
  /** Signs one short-lived, destination-bound start or stop attempt. */
  authorizeDispatch?(request: {
    readonly action: "start" | "stop";
    readonly placement: ProjectPlacementToken;
  }): Promise<string>;
  /** Publishes a signed committed lease to the destination Agent. */
  dispatchLeaseFenced?(placement: ProjectPlacementRecord): Promise<void>;
  /** Remote Agent transport that validates committed placement at execution. */
  dispatchStartFenced?(request: {
    readonly projectId: string;
    readonly nodeId: string;
    readonly placement: ProjectPlacementToken;
    readonly authority: string;
  }): Promise<void>;
  dispatchStopFenced?(request: {
    readonly projectId: string;
    readonly nodeId: string;
    readonly placement: ProjectPlacementToken;
    readonly authority: string;
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

export interface ZelavisProjectManagerOptions {
    store: ZelavisSystemStore;
    projectRecipes: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
    runtime: ZelavisProjectRuntimeDriver;
    resolveDefaultRuntimeKind?: () => Promise<ZelavisProjectRuntimeKind>;
    /**
     * Other backends policy lets a new Project use, in administrator order:
     * enabled, healthy and executable. Consulted only when the default cannot
     * satisfy a recipe's required isolation, and only at creation — an existing
     * Project's assignment is never changed by it.
     */
    resolveAlternativeRuntimeKinds?: () => Promise<readonly ZelavisProjectRuntimeKind[]>;
    /**
     * What this host can do for a recipe's install methods. Absent on a host that cannot prove
     * any, where a recipe with install methods is refused rather than guessed at.
     */
    installHost?: () => Promise<ZelavisProjectInstallHost>;
    /**
     * Told on every reconciliation how many replicas Fabric could not place for lack of
     * capacity (zero when none). Only reported where placement is authoritative, because a
     * host that models no capacity reports shortfalls that are not real. The answer is
     * ignored: whether to add capacity is not this manager's decision.
     */
    capacityShortfall?: (unplaced: number) => Promise<unknown>;
    /**
     * What a deployment backend advertises, for comparing with a recipe's locked
     * isolation intent. Absent on a host with no backend registry, where any
     * required intent is refused because nothing can prove it.
     */
    backendCapabilities?: (runtimeKind: ZelavisProjectRuntimeKind) => ZelavisDeploymentBackendCapabilities | undefined;
    cleanupParticipants?: readonly ZelavisProjectCleanupParticipant[];
    /** Platform ingress follows durable lifecycle changes without altering recipe locks. */
    synchronizeIngress?: (project: Readonly<ZelavisProjectRecord>) => Promise<ZelavisProjectPreview | undefined>;
    /**
     * Resolved lazily because Fabric is composed after the Project manager, and
     * absent on a host with no Fabric — which reconciles exactly as it did
     * before.
     */
    placement?: () => ZelavisProjectPlacementAuthority | undefined;
    /** Durable Platform ownership. When set, plans alone never authorize start. */
    authoritativePlacement?: ProjectPlacementAuthority;
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
}

const makeProjectManager = Effect.fn("Projects.make")(function* (options: ZelavisProjectManagerOptions): Effect.fn.Return<ZelavisProjectManager, TaggedFailure> {
    let closing = false;
    const lifecycleScope = Scope.makeUnsafe("parallel");
    const { projectRecipes, runtime } = options;
    const store = effectOperations(options.store);
    const runtimeEffects = effectOperations(runtime, ["capabilities", "supportsLiveUpdate"]);
    const availableRuntimeKinds = normalizeRecipeRuntimeKinds(runtime.runtimeKinds);
    const defaultRuntimeKind = yield* evaluate(() => normalizeRuntimeKind(runtime.defaultRuntimeKind ?? availableRuntimeKinds[0] ?? DEFAULT_RUNTIME_KIND));
    if (!availableRuntimeKinds.includes(defaultRuntimeKind)) {
        return yield* Effect.fail(new ZelavisProjectValidationError(`Default Project runtime kind "${defaultRuntimeKind}" is not available from driver "${runtime.name}".`));
    }
    const startupConcurrency = normalizeConcurrency(runtime.startupConcurrency);
    const placementSession = runtime.custody?.ownerSession ?? crypto.randomUUID();
    const placementLeaseMs = 60000;
    const localPlacementNodeId = options.dispatch?.()?.localNodeId ?? "local";
    const ownedPlacements = new Map<string, ProjectPlacementToken>();
    function assessIsolation(descriptor: Readonly<ZelavisProjectDescriptor>): ZelavisProjectIsolationAssessment | undefined {
        const intent = descriptor.recipe.isolation;
        return intent
            ? assessProjectIsolation(intent, descriptor.runtimeKind, options.backendCapabilities?.(descriptor.runtimeKind))
            : undefined;
    }
    const selectRuntimeKind = Effect.fn("Projects.selectRuntimeKind")(function* (recipe: ZelavisProjectRecipeLock, defaultKind: ZelavisProjectRuntimeKind): Effect.fn.Return<ZelavisProjectRuntimeKind, TaggedFailure> {
        const usable = (kind: ZelavisProjectRuntimeKind) => recipe.runtimeKinds.includes(kind) && availableRuntimeKinds.includes(kind);
        const assess = (kind: ZelavisProjectRuntimeKind) => recipe.isolation
            ? assessProjectIsolation(recipe.isolation, kind, options.backendCapabilities?.(kind))
            : undefined;
        const defaultAssessment = assess(defaultKind);
        if (usable(defaultKind) && (!defaultAssessment || defaultAssessment.satisfied)) {
            return defaultKind;
        }
        if (defaultAssessment && !defaultAssessment.satisfied && options.resolveAlternativeRuntimeKinds) {
            for (const candidate of (yield* integration(() => options.resolveAlternativeRuntimeKinds!()))) {
                const kind = yield* evaluate(() => normalizeRuntimeKind(candidate));
                if (kind !== defaultKind && usable(kind) && assess(kind)?.satisfied) {
                    return kind;
                }
            }
        }
        if (!recipe.runtimeKinds.includes(defaultKind)) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${recipe.name}" does not support the "${defaultKind}" runtime. Supported runtimes: ${recipe.runtimeKinds.join(", ")}.`));
        }
        if (!availableRuntimeKinds.includes(defaultKind)) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Project runtime "${defaultKind}" is not available on this Zelavis server. Available runtimes: ${availableRuntimeKinds.join(", ")}.`));
        }
        return yield* Effect.fail(new ZelavisProjectIsolationError(`Project recipe "${recipe.name}"`, defaultAssessment!));
    });
    /**
     * The install method and software version a new Project locks. Chosen once, from what this
     * host can do, and never again: a later start checks the lock and refuses, it does not pick.
     */
    const selectInstall = Effect.fn("Projects.selectInstall")(function* (
        entry: Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>,
        requested: { method?: string | undefined; softwareVersion?: string | undefined },
    ) {
        const manifest = entry.service.project?.install;
        if (!manifest) {
            if (requested.method !== undefined || requested.softwareVersion !== undefined) {
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${entry.service.name}" has no install method or software version to choose.`));
            }
            return undefined;
        }
        if (!options.installHost) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${entry.service.name}" installs through methods this host cannot prove it supports.`));
        }
        const host = yield* integration(() => options.installHost!());
        return yield* evaluate((): ZelavisProjectInstallLock => {
            try {
                const method = selectRecipeMethod(manifest, {
                    drivers: host.drivers, requirements: host.requirements,
                    ...(requested.method === undefined ? {} : { method: requested.method }),
                });
                const software = selectRecipeSoftware(manifest, requested.softwareVersion);
                return { method: method.id, driver: method.driver, requires: [...method.requires], software: software.version };
            } catch (error) {
                throw new ZelavisProjectValidationError(error instanceof Error ? error.message : String(error));
            }
        });
    });
    /** The refusal for a Project whose locked install method this host can no longer run. */
    const installRefusal = Effect.fn("Projects.installRefusal")(function* (project: Readonly<ZelavisProjectDescriptor>) {
        const install = project.recipe.install;
        if (!install) return undefined;
        const host = options.installHost ? yield* integration(() => options.installHost!()) : undefined;
        const missing = host === undefined
            ? ["a host that can prove its capabilities"]
            : [
                ...(host.drivers.includes(install.driver) ? [] : [`the ${install.driver} driver`]),
                ...install.requires.filter((name) => !host.requirements.includes(name)),
            ];
        return missing.length === 0 ? undefined : new ZelavisProjectValidationError(
            `Project "${project.id}" was created with the "${install.method}" install method, which needs ${missing.join(", ")}; this host does not provide it. Zelavis will not switch methods on its own.`);
    });
    /** The refusal for a Project whose required isolation is not proven. */
    function isolationRefusal(project: Readonly<ZelavisProjectDescriptor>): ZelavisProjectIsolationError | undefined {
        const assessment = assessIsolation(project);
        return assessment && !assessment.satisfied
            ? new ZelavisProjectIsolationError(`Project "${project.id}"`, assessment)
            : undefined;
    }
    const reconciliationRuns = new Map<string, Deferred.Deferred<void, TaggedFailure>>();
    const closeRuns = new Map<string, Deferred.Deferred<void, TaggedFailure>>();
    const deletionRuns = new Map<string, Deferred.Deferred<boolean, TaggedFailure>>();
    const cleanupParticipants = [
        // Owned Projects go before the host-supplied participants: a Project's own
        // runtime data must outlive the things that depend on it until they are
        // gone, and an owned runtime is only removable while its owner still
        // exists to describe it.
        {
            id: OWNED_PROJECTS_CLEANUP_PARTICIPANT,
            cleanup: Effect.fn("Projects.transition")(function* (project: Readonly<ZelavisProjectRecord>) {
                // The owner's lifecycle permit is already held. Inspect the
                // child identities without refreshing (and relocking) the owner.
                const records = yield* store.list(PROJECTS_NAMESPACE);
                const owned = yield* evaluate(() => records.map(record => normalizeStoredProject(record.value).project)
                    .filter(child => child.ownerProjectId === project.id));
                // Sequential, not concurrent: each removal is itself a durable,
                // resumable lifecycle, and a partial failure must leave a state the
                // next reconciliation can continue from.
                for (const child of owned) {
                    yield* manager.remove(child.id);
                }
            }),
        },
        ...(options.cleanupParticipants ?? []).map(participant => ({ ...participant, cleanup: effectOperations(participant).cleanup })),
        {
            id: RUNTIME_DATA_CLEANUP_PARTICIPANT,
            cleanup: (project: Readonly<ZelavisProjectRecord>) => runtimeEffects.destroy(project.id),
        },
    ].map((participant) => ({
        ...participant,
        id: normalizeCleanupParticipantId(participant.id),
    }));
    const cleanupParticipantIds = new Set<string>();
    for (const participant of cleanupParticipants) {
        if (cleanupParticipantIds.has(participant.id)) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Duplicate Project cleanup participant "${participant.id}".`));
        }
        cleanupParticipantIds.add(participant.id);
    }
    // Frontends are recipes too. A frontend is a Project like any other — it
    // gets a directory, a lifecycle, logs, and a routed target — and differs only
    // in what it runs and in being owned by the Project it fronts. Excluding it
    // here is what made an installed frontend package unselectable.
    const projectRecipeMap = new Map(projectRecipes
        .filter((entry) => entry.service.kind === "app" || entry.service.kind === "frontend")
        .flatMap((entry) => [
        [entry.service.name, entry] as const,
        ...(entry.specifier ? [[entry.specifier, entry] as const] : []),
    ]));
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
    function recipeStatusOf(recipe: ZelavisProjectRecipeLock): ZelavisProjectRecipeStatus {
        const shipped = projectRecipeMap.get(recipe.name);
        if (!shipped) {
            return {
                state: "unavailable",
                reason: `This Platform ships no recipe named "${recipe.name}".`,
            };
        }
        const version = shipped.service.version;
        return version && version !== recipe.version
            ? { state: "upgradeAvailable", version }
            : { state: "current" };
    }
    function readStoredRecipeHistory(raw: Record<string, unknown>): ZelavisProjectRecipeUpgrade[] {
        if (!Array.isArray(raw.recipeHistory))
            return [];
        return raw.recipeHistory.flatMap((entry): ZelavisProjectRecipeUpgrade[] => {
            const item = entry as {
                from?: {
                    name?: unknown;
                    version?: unknown;
                };
                upgradedAt?: unknown;
            };
            return typeof item?.from?.name === "string" && typeof item.from.version === "string" &&
                typeof item.upgradedAt === "string"
                ? [{ from: { name: item.from.name, version: item.from.version }, upgradedAt: item.upgradedAt }]
                : [];
        }).slice(-10);
    }
    function readEngineVersion(value: Record<string, unknown>): { engineVersion?: string } {
        if (value.engineVersion === undefined) return {};
        if (!isExactVersion(value.engineVersion)) throw new ZelavisProjectValidationError("Engine selection requires an exact version.");
        return { engineVersion: value.engineVersion };
    }
    function readStoredRuntimeUpdate(raw: Record<string, unknown>): ZelavisProjectRuntimeUpdateIntent | undefined {
        if (raw.runtimeUpdate === undefined) return undefined;
        const update = raw.runtimeUpdate;
        if (!isObjectRecord(update) || typeof update.id !== "string" || update.id.length > 128 || typeof update.startedAt !== "string" ||
            !isObjectRecord(update.execution) || !isObjectRecord(update.previous) || !isObjectRecord(update.target)) throw new ZelavisProjectValidationError("Malformed persisted Project handover.");
        const identity = (value: unknown): RuntimeRelease => {
            if (!isObjectRecord(value) || typeof value.version !== "string" || !/^sha256:[a-f0-9]{64}$/.test(String(value.digest))) throw new ZelavisProjectValidationError("Project handover requires immutable execution identities.");
            return { version: value.version, digest: String(value.digest) };
        };
        const state = (value: Record<string, unknown>) => {
            if (typeof value.kind !== "string") throw new ZelavisProjectValidationError("Project handover requires an explicit recipe kind.");
            return { kind: value.kind, recipe: readStoredRecipeLock(value), recipeHistory: readStoredRecipeHistory(value), engineVersion: readEngineVersion(value).engineVersion };
        };
        const previous = state(update.previous), target = state(update.target);
        const recipe = readStoredRecipeLock({ recipe: update.execution.recipe });
        if (update.execution.mode !== "engine" && update.execution.mode !== "integration" && update.execution.mode !== "recipe") throw new ZelavisProjectValidationError("Project update requires an explicit execution mode.");
        if (recipe.name !== target.recipe.name || recipe.version !== target.recipe.version || recipe.artifact?.digest !== target.recipe.artifact?.digest) throw new ZelavisProjectValidationError("Project handover target differs from its persisted recipe lock.");
        return { id: update.id, startedAt: update.startedAt, previous, target,
            execution: { mode: update.execution.mode, ...(update.execution.host === true ? { host: true as const } : {}), previous: identity(update.execution.previous), target: identity(update.execution.target), recipe },
            ...(typeof update.error === "string" ? { error: update.error.slice(0, 4000) } : {}) };
    }
    function normalizeStoredProject(value: ZelavisSystemStoreValue): {
        project: ZelavisProjectRecord;
        repaired: boolean;
    } {
        const rawProject = parseStoredProject(value);
        const rawRecord = rawProject as unknown as Record<string, unknown>;
        const storedRecipe = readStoredRecipeLock(rawRecord);
        const deletion = readStoredDeletionState(rawRecord);
        const definition = runtime.recipeDefinition?.({ id: rawProject.id, name: rawProject.name,
            kind: rawProject.kind, recipe: storedRecipe, runtimeKind: normalizeRuntimeKind(rawRecord.runtimeKind ?? DEFAULT_RUNTIME_KIND) });
        // The selected frozen package owns its definition. Catalogue metadata is
        // only a pre-acquisition preview, never authority over running routing.
        const recipe = definition ? { ...storedRecipe, runtimeKinds: normalizeRecipeRuntimeKinds(definition.runtimeKinds),
            managed: definition.managed, hostPackages: definition.hostPackages, isolation: definition.isolation } : storedRecipe;
        const storedOwner = typeof (rawProject as {
            ownerProjectId?: unknown;
        }).ownerProjectId === "string"
            ? ((rawProject as {
                ownerProjectId: string;
            }).ownerProjectId)
            : undefined;
        const descriptor: ZelavisProjectDescriptor = {
            id: rawProject.id,
            name: rawProject.name,
            kind: rawProject.kind || projectKindForRecipe(recipe.name),
            recipe,
            ...readEngineVersion(rawRecord),
            // Ownership must survive a restart. Dropping it here would orphan every
            // owned runtime, because deletion reaches them through their owner.
            ...(storedOwner ? { ownerProjectId: storedOwner } : {}),
            runtimeKind: rawRecord.runtimeKind === undefined
                ? DEFAULT_RUNTIME_KIND
                : normalizeRuntimeKind(rawRecord.runtimeKind),
        };
        const capabilities = runtime.capabilities(descriptor);
        const isolation = assessIsolation(descriptor);
        const history = readStoredRecipeHistory(rawRecord);
        const project: ZelavisProjectRecord = {
            ...descriptor,
            recipeStatus: recipeStatusOf(recipe),
            ...(history.length ? { recipeHistory: history } : {}),
            capabilities,
            ...(isolation ? { isolation } : {}),
            desiredState: rawProject.desiredState,
            runtime: rawProject.runtime?.driver && rawProject.runtime.status
                ? rawProject.runtime
                : {
                    driver: runtime.name,
                    status: "stopped",
                },
            ...(deletion ? { deletion } : {}),
            ...(rawRecord.runtimeUpdate !== undefined ? { runtimeUpdate: readStoredRuntimeUpdate(rawRecord) } : {}),
            ...(rawProject.placement ? { placement: rawProject.placement } : {}),
            createdAt: rawProject.createdAt,
            updatedAt: rawProject.updatedAt,
        };
        return {
            project,
            repaired: JSON.stringify(rawRecord.recipe) !== JSON.stringify(recipe) ||
                rawRecord.app !== undefined ||
                rawRecord.runtimeKind !== project.runtimeKind ||
                rawProject.kind !== project.kind ||
                JSON.stringify(rawRecord.capabilities) !==
                    JSON.stringify(capabilities) ||
                JSON.stringify(rawRecord.isolation) !== JSON.stringify(isolation) ||
                rawProject.runtime !== project.runtime,
        };
    }
    const read = Effect.fn("Projects.read")(function* (id: string): Effect.fn.Return<ZelavisProjectRecord | undefined, TaggedFailure> {
        const record = yield* store.get(PROJECTS_NAMESPACE, (yield* evaluate(() => normalizeProjectId(id))));
        if (!record) {
            return undefined;
        }
        const { project } = yield* evaluate(() => normalizeStoredProject(record.value));
        return project;
    });
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
    const withProjectLifecycle = lifecycleGate();
    const write = Effect.fn("Projects.write")(function* (project: ZelavisProjectRecord): Effect.fn.Return<ZelavisProjectRecord, TaggedFailure> {
        const { preview: _preview, ...record } = project;
        yield* store.set(PROJECTS_NAMESPACE, project.id, toStoreValue(record));
        return yield* ingressView(record);
    });
    const ingressView = Effect.fn("Projects.ingressView")(function* (project: ZelavisProjectRecord): Effect.fn.Return<ZelavisProjectRecord, TaggedFailure> {
        return yield* Effect.catch(Effect.gen(function* () {
            const preview = (yield* integration(() => options.synchronizeIngress?.(project)));
            return preview ? { ...project, preview } : project;
        }), Effect.fn("Projects.recover")(function* (_error) {
            // Ingress failure is independent of the runtime's durable lifecycle.
            return { ...project, preview: { status: "unavailable" as const, error: "Site preview ingress is unavailable." } };
        }));
    });
    const requireProject = Effect.fn("Projects.requireProject")(function* (id: string): Effect.fn.Return<ZelavisProjectRecord, TaggedFailure> {
        const project = yield* read(id);
        if (!project) {
            return yield* Effect.fail(new ZelavisProjectNotFoundError(`Project "${id}" was not found.`));
        }
        return project;
    });
    const recoverProjectUpdate = Effect.fn("Projects.recoverUpdate")(function* (project: ZelavisProjectRecord) {
        const intent = project.runtimeUpdate;
        if (!intent) return project;
        if (!runtimeEffects.recoverUpdate) return yield* new IntegrationFailure(new Error("Project driver cannot recover its persisted runtime update."));
        const choice = yield* runtimeEffects.recoverUpdate(project.id, intent.execution);
        const { runtimeUpdate: _intent, ...settled } = project;
        const selected = { ...settled, ...intent[choice] };
        return yield* write({ ...selected, capabilities: runtime.capabilities(selected), updatedAt: new Date().toISOString() });
    });
    function assertProjectIsOperable(project: ZelavisProjectRecord, operation: string): void {
        if (project.deletion) {
            throw new ZelavisProjectConflictError(`Project "${project.id}" is pending deletion and cannot be ${operation}. Retry deletion instead.`);
        }
        if (project.runtimeUpdate) throw new ZelavisProjectConflictError(`Project "${project.id}" has an unfinished runtime update. Reconciliation must recover it before it can be ${operation}.`);
    }
    // Persisted refreshes hold the lifecycle permit. Fleet reads are a pure
    // view: Fabric may read them while a Project transition holds its permit.
    const refresh = Effect.fn("Projects.refresh")(function* (id: string, persist: boolean): Effect.fn.Return<ZelavisProjectRecord | undefined, TaggedFailure> {
        const record = yield* store.get(PROJECTS_NAMESPACE, id);
        if (!record) return undefined;
        const { project, repaired } = yield* evaluate(() => normalizeStoredProject(record.value));
        if (repaired && persist) yield* write(project);
        if (project.runtime.status === "provisioning" || project.deletion || project.runtimeUpdate) {
            return project;
        }
        const snapshot = yield* runtimeEffects.status(project.id);
        // A start that failed before any process existed (a recipe that cannot be
        // prepared, a refused placement) leaves the driver with nothing to report.
        // "Nothing running" must not erase the reason: the failure stays until the
        // next lifecycle action replaces it.
        if (project.runtime.status === "failed" &&
            project.runtime.error &&
            snapshot.status === "stopped" &&
            !snapshot.error) {
            return project;
        }
        const unchanged = snapshot.status === project.runtime.status &&
            snapshot.url === project.runtime.url &&
            snapshot.error === project.runtime.error;
        const current = unchanged ? project : applySnapshot(project, snapshot);
        return yield* (unchanged || !persist ? ingressView(current) : write(current));
    });
    const deleteProject = Effect.fn("Projects.deleteProject")(function* (id: string): Effect.fn.Return<boolean, TaggedFailure> {
        const existingProject = yield* read(id);
        if (!existingProject) {
            return false;
        }
        let project: ZelavisProjectRecord = existingProject;
        const startedAt = project.deletion?.startedAt ?? new Date().toISOString();
        const completedParticipants = new Set(project.deletion?.completedParticipants ?? []);
        const plannedParticipants = [
            ...new Set([
                ...(project.deletion?.participants ?? []).filter((id) => id !== RUNTIME_DATA_CLEANUP_PARTICIPANT),
                ...cleanupParticipants
                    .map((participant) => participant.id)
                    .filter((id) => id !== RUNTIME_DATA_CLEANUP_PARTICIPANT),
            ]),
            RUNTIME_DATA_CLEANUP_PARTICIPANT,
        ];
        let participantId = "runtime-stop";
        project = (yield* write({
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
        }));
        return yield* Effect.catch(Effect.gen(function* () {
            const stopped = (yield* stopPlacedRuntime(project.id));
            project = (yield* write({
                ...applySnapshot(project, stopped),
                deletion: {
                    status: "running",
                    startedAt,
                    updatedAt: new Date().toISOString(),
                    participants: plannedParticipants,
                    completedParticipants: [...completedParticipants],
                },
            }));
            for (const plannedId of plannedParticipants) {
                if (!completedParticipants.has(plannedId) &&
                    !cleanupParticipantIds.has(plannedId)) {
                    participantId = plannedId;
                    return (yield* new IntegrationFailure(new Error(`Required Project cleanup participant "${plannedId}" is unavailable.`)));
                }
            }
            for (const participant of cleanupParticipants) {
                if (completedParticipants.has(participant.id)) {
                    continue;
                }
                participantId = participant.id;
                project = (yield* write({
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
                }));
                yield* participant.cleanup(project);
                completedParticipants.add(participant.id);
                project = (yield* write({
                    ...project,
                    deletion: {
                        status: "running",
                        startedAt,
                        updatedAt: new Date().toISOString(),
                        participants: plannedParticipants,
                        completedParticipants: [...completedParticipants],
                    },
                    updatedAt: new Date().toISOString(),
                }));
            }
            participantId = "project-record";
            const deleted = (yield* store.delete(PROJECTS_NAMESPACE, project.id));
            if (!deleted && ((yield* read(project.id)))) {
                return (yield* new IntegrationFailure(new Error("The Platform System Store did not delete the Project record.")));
            }
            return true;
        }), Effect.fn("Projects.recover")(function* (error) {
            const failedAt = new Date().toISOString();
            const failureSnapshot = (yield* Effect.catch(runtimeEffects.status(project.id), Effect.fn("Projects.recover")(function* () { return ({
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
            }); })));
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
            (yield* Effect.catch(write(failedProject), Effect.fn("Projects.recover")(function* () { return undefined; })));
            return (yield* Effect.fail(new ZelavisProjectDeletionError({
                projectId: project.id,
                participantId,
                cause: unwrapFailure(error),
            })));
        })).pipe(Effect.onErrorIf(Cause.hasInterrupts, () => write({
            ...project,
            desiredState: "stopped",
            deletion: { status: "failed", startedAt, updatedAt: new Date().toISOString(),
                participants: plannedParticipants, completedParticipants: [...completedParticipants],
                currentParticipant: participantId, error: "Deletion was interrupted. Retry deletion to continue cleanup." },
            updatedAt: new Date().toISOString(),
        }).pipe(Effect.asVoid, Effect.orDie)));
    });
    const resolvePlacementDecisions = Effect.fn("Projects.resolvePlacementDecisions")(function* (records: readonly {
        value: ZelavisSystemStoreValue;
    }[], planOptions: {
        readonly alsoPlan?: string;
    } = {}): Effect.fn.Return<{
        /** Left stopped: no node may run it, whatever this host does. */
        readonly blocked: ReadonlySet<string>;
        /** Placed on another node, mapped to the node that owns it. */
        readonly elsewhere: ReadonlyMap<string, string>;
    }, TaggedFailure> {
        const empty = { blocked: new Set<string>(), elsewhere: new Map<string, string>() };
        const authority = options.placement?.();
        if (!authority) {
            if (options.authoritativePlacement) {
                return yield* Effect.fail(new ZelavisProjectValidationError("Platform Fabric planning is unavailable."));
            }
            return empty;
        }
        const requests: FabricProjectPlacementRequest[] = [];
        for (const record of records) {
            const { project } = yield* evaluate(() => normalizeStoredProject(record.value));
            if (project.deletion)
                continue;
            if (project.desiredState !== "running" &&
                project.id !== planOptions.alsoPlan) {
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
        const localNodeId = options.authoritativePlacement
            ? localPlacementNodeId
            : options.dispatch?.()?.localNodeId;
        // Nothing owns anything and this host does not know which node it is, so
        // there is no group to violate and no assignment to compare against.
        if (!localNodeId && !requests.some((request) => request.ownerProjectId) &&
            !options.authoritativePlacement) {
            return empty;
        }
        const plan = yield* Effect.catch(integration(() => authority
            .planProjectPlacements(requests)), Effect.fn("Projects.recover")(function* () { return undefined; }));
        if (!plan)
            return options.authoritativePlacement
                ? { blocked: new Set(requests.map((request) => request.identity.workloadId)), elsewhere: new Map() }
                : empty;
        if (options.authoritativePlacement && options.capacityShortfall) {
            const shortfall = plan.unplaced.filter((replica) => replica.reason === "insufficient-capacity").length;
            yield* Effect.catch(integration(() => options.capacityShortfall!(shortfall)), Effect.fn("Projects.shortfallObserver")(function* () { return undefined; }));
        }
        const blocked = new Set<string>();
        for (const replica of plan.unplaced) {
            if (options.authoritativePlacement || BLOCKING_PLACEMENT_REASONS.has(replica.reason)) {
                blocked.add(replica.identity.workloadId);
            }
        }
        const elsewhere = new Map<string, string>();
        for (const replica of plan.replicas) {
            const projectId = replica.identity.workloadId;
            let nodeId = replica.runtimeNodeId;
            if (options.authoritativePlacement) {
                const committed = yield* ensureCommittedPlacement(projectId, nodeId);
                if (!committed) {
                    blocked.add(projectId);
                    continue;
                }
                nodeId = committed.nodeId;
            }
            if (localNodeId && nodeId !== localNodeId) {
                elsewhere.set(projectId, nodeId);
            }
        }
        return { blocked, elsewhere };
    });
    /**
     * One claim per Project at a time. Startup reconciliation and a person's click
     * can both ask for the same Project's placement at once; each would read the
     * same epoch and both would try to take it, and the one that lost was reported
     * as having no placement at all, though the winner was this very session.
     * Asking again while a claim is in flight joins it.
     */
    const placementClaims = new Map<string, Deferred.Deferred<ProjectPlacementRecord | undefined, TaggedFailure>>();
    function ensureCommittedPlacement(projectId: string, plannedNodeId: string) {
        return singleFlight(placementClaims, `${projectId}\u0000${plannedNodeId}`, () => commitPlacement(projectId, plannedNodeId));
    }
    const commitPlacement = Effect.fn("Projects.commitPlacement")(function* (projectId: string, plannedNodeId: string): Effect.fn.Return<ProjectPlacementRecord | undefined, TaggedFailure> {
        const authority = options.authoritativePlacement;
        if (!authority)
            return undefined;
        const current = yield* integration(() => authority.current(projectId));
        if (current?.state === "active" && current.leaseExpiresAt > Date.now()) {
            // An older Platform session still owns it. Wait for its expiry or an
            // explicit stop; never start or redispatch a second copy.
            if (current.ownerSession !== placementSession)
                return undefined;
            const claim = {
                projectId, nodeId: current.nodeId,
                ownerSession: placementSession, epoch: current.epoch,
            };
            const renewed = yield* integration(() => authority.renew(claim, placementLeaseMs));
            if (!renewed.granted)
                return undefined;
            ownedPlacements.set(projectId, claim);
            return renewed.placement;
        }
        if (current?.state === "active" && current.ownerSession === placementSession &&
            current.nodeId === localPlacementNodeId) {
            yield* runtimeEffects.stop(projectId);
        }
        const activated = yield* integration(() => authority.acquire({
            projectId, nodeId: plannedNodeId, ownerSession: placementSession,
            expectedEpoch: current?.epoch ?? 0, leaseMs: placementLeaseMs,
        }));
        if (!activated.granted)
            return undefined;
        ownedPlacements.set(projectId, {
            projectId, nodeId: activated.placement.nodeId,
            ownerSession: placementSession, epoch: activated.placement.epoch,
        });
        return activated.placement;
    });
    const localPlacementToken = Effect.fn("Projects.localPlacementToken")(function* (projectId: string): Effect.fn.Return<ProjectPlacementToken | undefined, TaggedFailure> {
        const authority = options.authoritativePlacement;
        if (!authority)
            return undefined;
        const token = ownedPlacements.get(projectId);
        if (!token || token.nodeId !== localPlacementNodeId ||
            !((yield* integration(() => authority.validate(token))))) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" has no current local Fabric placement.`));
        }
        return token;
    });
    const stopPlacedRuntime = Effect.fn("Projects.stopPlacedRuntime")(function* (projectId: string): Effect.fn.Return<ZelavisProjectRuntimeSnapshot, TaggedFailure> {
        const token = ownedPlacements.get(projectId);
        if (options.authoritativePlacement && !token) {
            const current = yield* integration(() => options.authoritativePlacement!.current(projectId));
            if (current?.state === "active" && current.leaseExpiresAt > Date.now() &&
                current.nodeId !== localPlacementNodeId) {
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" is remotely owned; this host cannot confirm its stop.`));
            }
        }
        if (options.authoritativePlacement && token && token.nodeId !== localPlacementNodeId) {
            if (!options.dispatch?.()?.dispatchStopFenced ||
                !options.dispatch?.()?.authorizeDispatch) {
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" has no fenced remote stop path.`));
            }
            const authority = yield* integration(() => options.dispatch!()!.authorizeDispatch!({ action: "stop", placement: token }));
            yield* integration(() => options.dispatch!()!.dispatchStopFenced!({
                projectId, nodeId: token.nodeId, placement: token, authority,
            }));
            const released = yield* integration(() => options.authoritativePlacement!.release(token));
            if (!released.granted)
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" lost placement authority during stop.`));
            ownedPlacements.delete(projectId);
            return { status: "stopped" };
        }
        const stopped = yield* runtimeEffects.stop(projectId);
        if (token && options.authoritativePlacement) {
            const released = yield* integration(() => options.authoritativePlacement!.release(token));
            if (!released.granted)
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" lost placement authority during stop.`));
            ownedPlacements.delete(projectId);
        }
        return stopped;
    });
    const startLocally = Effect.fn("Projects.startLocally")(function* (id: string): Effect.fn.Return<ZelavisProjectRecord, TaggedFailure> {
        let project = yield* requireProject(id);
        // Starting it here settles the question the note recorded, so the note
        // goes rather than lingering as a stale explanation of a state that has
        // changed.
        const { placement: _placedElsewhere, ...withoutPlacement } = project;
        project = (yield* write({
            ...withoutPlacement,
            desiredState: "running",
            runtime: { driver: runtime.name, status: "starting" },
            updatedAt: new Date().toISOString(),
        }));
        return yield* Effect.catch(Effect.gen(function* () {
            // Refused inside the try so it is recorded as a failure with its reason,
            // and before `prepare`, so the driver never runs for it.
            const refusal = isolationRefusal(project) ?? (yield* installRefusal(project));
            if (refusal)
                return (yield* Effect.fail(refusal));
            const placement = (yield* localPlacementToken(project.id));
            (yield* runtimeEffects.prepare(project, project.recipe));
            return (yield* write(applySnapshot(project, (yield* runtimeEffects.start(project, placement)))));
        }), Effect.fn("Projects.recover")(function* (error) {
            const failed = {
                ...project,
                runtime: {
                    driver: runtime.name,
                    status: "failed" as const,
                    error: error instanceof Error ? error.message : String(error),
                },
                updatedAt: new Date().toISOString(),
            };
            (yield* write(failed));
            return (yield* Effect.fail(error));
        }));
    });
    const resolveAssignedNodeElsewhere = Effect.fn("Projects.resolveAssignedNodeElsewhere")(function* (projectId: string): Effect.fn.Return<string | undefined, TaggedFailure> {
        if (!options.dispatch?.()?.localNodeId)
            return undefined;
        const records = yield* store.list(PROJECTS_NAMESPACE);
        // Planned as though it were already desired-running: it is about to be,
        // and a Project that is currently stopped contributes no request, so
        // without this the answer would always be "placed here".
        const placement = yield* resolvePlacementDecisions(records, {
            alsoPlan: projectId,
        });
        if (placement.blocked.has(projectId)) {
            return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${projectId}" has no committed Fabric placement.`));
        }
        return placement.elsewhere.get(projectId);
    });
    const dispatchElsewhere = Effect.fn("Projects.dispatchElsewhere")(function* (project: ZelavisProjectRecord, nodeId: string): Effect.fn.Return<void, TaggedFailure> {
        const dispatcher = options.dispatch?.();
        const now = new Date().toISOString();
        if (project.desiredState !== "running") {
            project = (yield* write({ ...project, desiredState: "running", updatedAt: now }));
        }
        const placement = ownedPlacements.get(project.id);
        const fencedDispatch = options.authoritativePlacement !== undefined;
        if (dispatcher && (fencedDispatch
            ? dispatcher.dispatchStartFenced && dispatcher.dispatchStopFenced &&
                dispatcher.dispatchLeaseFenced &&
                dispatcher.authorizeDispatch && placement
            : dispatcher.dispatchStart)) {
            return yield* Effect.catch(Effect.gen(function* () {
                if (fencedDispatch) {
                    if (!placement || placement.nodeId !== nodeId ||
                        !((yield* integration(() => options.authoritativePlacement!.validate(placement))))) {
                        return (yield* new IntegrationFailure(new Error("The remote Project placement is no longer current.")));
                    }
                    const committed = (yield* integration(() => options.authoritativePlacement!.current(project.id)));
                    if (!committed || committed.epoch !== placement.epoch ||
                        committed.ownerSession !== placement.ownerSession) {
                        return (yield* new IntegrationFailure(new Error("The remote Project lease is no longer committed.")));
                    }
                    (yield* integration(() => dispatcher.dispatchLeaseFenced!(committed)));
                    const authority = (yield* integration(() => dispatcher.authorizeDispatch!({ action: "start", placement })));
                    (yield* integration(() => dispatcher.dispatchStartFenced!({ projectId: project.id, nodeId, placement, authority })));
                }
                else {
                    (yield* integration(() => dispatcher.dispatchStart!({ projectId: project.id, nodeId })));
                }
                (yield* Effect.catch(write({
                    ...project,
                    placement: { nodeId, dispatchedAt: now },
                    updatedAt: now,
                }), Effect.fn("Projects.recover")(function* () { return undefined; })));
                return;
            }), Effect.fn("Projects.recover")(function* (error) {
                (yield* Effect.catch(write({
                    ...project,
                    placement: {
                        nodeId,
                        error: error instanceof Error ? error.message : String(error),
                    },
                    updatedAt: now,
                }), Effect.fn("Projects.recover")(function* () { return undefined; })));
                return;
            }));
        }
        // `desiredState` stays "running": the Project is not stopped by intent,
        // it is unstarted by this host, and a later reconcile with a dispatcher
        // configured — or a placement that names this node — starts it.
        yield* Effect.catch(write({
            ...project,
            placement: {
                nodeId,
                error: `This host cannot start Projects on node "${nodeId}".`,
            },
            updatedAt: now,
        }), Effect.fn("Projects.recover")(function* () { return undefined; }));
        const snapshot = yield* runtimeEffects.status(project.id);
        if (snapshot.status === "running" || snapshot.status === "starting") {
            // It is running here and no longer placed here. Stopping it is this
            // host's half of the move; the node that now owns it starts it. The
            // driver is asked directly rather than through `stop`, which would clear
            // `desiredState` and make the move look like an operator stopping it.
            yield* Effect.catch(runtimeEffects.stop(project.id), Effect.fn("Projects.recover")(function* () { return undefined; }));
        }
    });
    const reconcileFleet = Effect.fn("Projects.reconcileFleet")(function* () {
                const existing = (yield* store.list(PROJECTS_NAMESPACE));
                const placement = (yield* resolvePlacementDecisions(existing));
                (yield* mapWithConcurrency(existing, startupConcurrency, Effect.fn("Projects.transition")(function* (record: ZelavisSystemStoreRecord) {
                    if (closing) {
                        return;
                    }
                    const normalized = (yield* evaluate(() => normalizeStoredProject(record.value)));
                    let project = normalized.project;
                    const repaired = normalized.repaired;
                    if (repaired) {
                        const latest = yield* withProjectLifecycle(project.id, () => Effect.gen(function* () {
                            const current = yield* read(project.id);
                            return current ? yield* write(current) : undefined;
                        }));
                        if (!latest) return;
                        project = latest;
                    }
                    if (project.deletion) {
                        (yield* Effect.catch(manager.remove(project.id), Effect.fn("Projects.recover")(function* () { return undefined; })));
                        return;
                    }
                    if (project.runtimeUpdate) {
                        const recovery = yield* Effect.result(withProjectLifecycle(project.id, Effect.fn("Projects.reconcileUpdate")(function* () {
                            const latest = yield* requireProject(project.id);
                            if (latest.deletion) return latest;
                            return yield* recoverProjectUpdate(latest);
                        })));
                        if (recovery._tag === "Failure") return;
                        project = recovery.success;
                    }
                    if (project.desiredState !== "running") {
                        // Adoption can hand back a Project the operator has since
                        // stopped: it kept running because nothing was there to stop it,
                        // and the Platform now has the handle it was missing. Leaving it
                        // running would make "stopped" mean "stopped, unless it happened
                        // to survive a crash".
                        const running = (yield* runtimeEffects.status(project.id));
                        if (running.status === "running" || running.status === "starting") {
                            // `stop` takes the lifecycle lock itself. Wrapping it here
                            // deadlocks: the queue is per Project, and the outer entry
                            // would wait for an inner one that cannot start until it
                            // returns.
                            (yield* Effect.catch(manager.stop(project.id), Effect.fn("Projects.recover")(function* () { return undefined; })));
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
                        (yield* dispatchElsewhere(project, assignedNodeId));
                        return;
                    }
                    const snapshot = (yield* runtimeEffects.status(project.id));
                    if (!closing &&
                        snapshot.status !== "running" &&
                        snapshot.status !== "starting") {
                        // Placement was decided once for the whole fleet above, so this
                        // starts locally rather than re-planning per Project — but it
                        // still takes the Project's lifecycle lock. Reconciliation runs
                        // concurrently with whatever an operator is doing, and a start
                        // interleaved with another start or a stop leaves the System
                        // Store describing a process that is not what is running.
                        yield* Effect.catch(withProjectLifecycle(project.id, Effect.fn("Projects.reconcileStart")(function* () {
                            // Creation or an operator transition may finish while this pass waits for its permit.
                            const current = yield* read(project.id);
                            if (closing || !current || current.deletion || current.desiredState !== "running") return;
                            const latest = yield* runtimeEffects.status(project.id);
                            if (latest.status === "running" || latest.status === "starting") return;
                            yield* startLocally(project.id);
                        })), () => Effect.void);
                    }
                })));
            });
    const startPlaced = Effect.fn("Projects.startPlaced")(function* (id: string) {
                const placed = (yield* requireProject(id));
                (yield* evaluate(() => assertProjectIsOperable(placed, "started")));
                // An explicit start is still subject to placement. Told to run a Project
                // this host is not placed to run, saying so is the only answer that does
                // not quietly contradict the Fabric.
                const assignedNodeId = (yield* resolveAssignedNodeElsewhere(placed.id));
                if (assignedNodeId !== undefined) {
                    (yield* dispatchElsewhere(placed, assignedNodeId));
                    const dispatched = options.authoritativePlacement
                        ? options.dispatch?.()?.dispatchStartFenced !== undefined &&
                            options.dispatch?.()?.dispatchStopFenced !== undefined &&
                            options.dispatch?.()?.dispatchLeaseFenced !== undefined &&
                            options.dispatch?.()?.authorizeDispatch !== undefined
                        : options.dispatch?.()?.dispatchStart !== undefined;
                    if (!dispatched) {
                        return (yield* Effect.fail(new ZelavisProjectValidationError(`Project "${placed.id}" is placed on node "${assignedNodeId}", which this host cannot start Projects on.`)));
                    }
                    const dispatchedProject = (yield* requireProject(id));
                    if (dispatchedProject.placement?.error) {
                        return (yield* Effect.fail(new ZelavisProjectValidationError(dispatchedProject.placement.error)));
                    }
                    return dispatchedProject;
                }
                return (yield* startLocally(id));
    });
    const manager: EffectOperations<ZelavisProjectManager> = {
        runtime: {
            driver: runtime.name,
            availableKinds: availableRuntimeKinds,
        },
        list: Effect.fn("Projects.list")(function* (options?: Parameters<ZelavisProjectManager["list"]>[0]) {
            const records = yield* store.list(PROJECTS_NAMESPACE);
            const projects = yield* mapWithConcurrency(records, startupConcurrency, Effect.fn("Projects.transition")(function* (record: ZelavisSystemStoreRecord) {
                const { project } = yield* evaluate(() => normalizeStoredProject(record.value));
                return yield* refresh(project.id, false);
            }));
            const presentProjects = projects.filter((project): project is ZelavisProjectRecord => project !== undefined);
            const visible = options?.includeOwned
                ? presentProjects
                : presentProjects.filter((project) => project.ownerProjectId === undefined);
            return visible.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        }),
        listOwned: Effect.fn("Projects.listOwned")(function* (ownerProjectId: Parameters<ZelavisProjectManager["listOwned"]>[0]) {
            const owner = yield* evaluate(() => normalizeProjectId(ownerProjectId));
            const all = yield* manager.list({ includeOwned: true });
            return all.filter((project) => project.ownerProjectId === owner);
        }),
        get: Effect.fn("Projects.get")(function* (id: Parameters<ZelavisProjectManager["get"]>[0]) {
            const projectId = yield* evaluate(() => normalizeProjectId(id));
            return yield* withProjectLifecycle(projectId, () => refresh(projectId, true));
        }),
        versions: Effect.fn("Projects.versions")(function* (id?: string) {
            const unavailable = { selectable: false, reason: "This runtime cannot select independent engine versions.", versions: [] };
            if (id === undefined) return yield* (runtimeEffects.versions?.() ?? Effect.succeed(unavailable));
            const projectId = yield* evaluate(() => normalizeProjectId(id));
            return yield* withProjectLifecycle(projectId, () => Effect.gen(function* () {
                const project = yield* requireProject(projectId);
                if (project.placement) return { selectable: false, reason: "Version selection requires the Project's local runtime catalog.", versions: [] };
                return yield* (runtimeEffects.versions?.(project) ?? Effect.succeed(unavailable));
            }));
        }),
        switchVersion: Effect.fn("Projects.switchVersion")(function* (id: string, version: string) {
            yield* evaluate(() => { if (!isExactVersion(version)) throw new ZelavisProjectValidationError("Engine selection requires an exact version."); });
            return yield* manager.upgrade(id, { engineVersion: version });
        }),
        create: Effect.fn("Projects.create")(function* (input: Parameters<ZelavisProjectManager["create"]>[0]) {
            const name = yield* evaluate(() => normalizeProjectName(input.name));
            const id = yield* evaluate(() => normalizeProjectId(input.id ?? name));
            const recipeName = input.recipeName?.trim() || DEFAULT_PROJECT_RECIPE_NAME;
            const projectRecipe = projectRecipeMap.get(recipeName);
            if (!projectRecipe) {
                return yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${recipeName}" was not found.`));
            }
            let recipe = yield* evaluate(() => recipeLockFromRegistryEntry(projectRecipe));
            const install = yield* selectInstall(projectRecipe, { method: input.method, softwareVersion: input.softwareVersion });
            if (install) recipe = { ...recipe, install };
            const defaultKind = normalizeRuntimeKind(options.resolveDefaultRuntimeKind
                ? (yield* integration(() => options.resolveDefaultRuntimeKind!())) : defaultRuntimeKind);
            const runtimeKind = yield* selectRuntimeKind(recipe, defaultKind);
            const now = new Date().toISOString();
            const ownerProjectId = input.ownerProjectId
                ? (yield* evaluate(() => normalizeProjectId(input.ownerProjectId!)))
                : undefined;
            if (ownerProjectId) {
                if (ownerProjectId === id) {
                    return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${id}" cannot own itself.`));
                }
                const owner = yield* read(ownerProjectId);
                if (!owner) {
                    return yield* Effect.fail(new ZelavisProjectValidationError(`Owner Project "${ownerProjectId}" was not found.`));
                }
                if (owner.ownerProjectId) {
                    return yield* Effect.fail(new ZelavisProjectValidationError(`Project "${ownerProjectId}" is itself owned, and nested ownership is not supported yet.`));
                }
                if (owner.deletion) {
                    return yield* Effect.fail(new ZelavisProjectValidationError(`Owner Project "${ownerProjectId}" is being deleted.`));
                }
            }
            const descriptor: ZelavisProjectDescriptor = {
                ...readEngineVersion(input as unknown as Record<string, unknown>),
                id,
                ...(ownerProjectId ? { ownerProjectId } : {}),
                name,
                kind: projectKindForRecipe(recipe.name),
                recipe,
                runtimeKind,
            };
            if (input.engineVersion !== undefined && !runtimeEffects.resolveVersion)
                return yield* Effect.fail(new ZelavisProjectValidationError("This runtime cannot select an independent engine version."));
            const selection = yield* (runtimeEffects.resolveVersion?.(descriptor, input.engineVersion) ?? Effect.succeed(undefined));
            if (input.engineVersion !== undefined && !selection)
                return yield* Effect.fail(new ZelavisProjectValidationError("Engine version selection requires an installed native Zelavis App."));
            if (selection) { recipe = selection.recipe; descriptor.recipe = recipe; descriptor.engineVersion = selection.engineVersion; }
            // Refused before the identifier is claimed: nothing is provisioned for a
            // Project this server cannot run with the isolation its recipe requires.
            const isolation = assessIsolation(descriptor);
            if (isolation && !isolation.satisfied) {
                return yield* Effect.fail(new ZelavisProjectIsolationError(`Project recipe "${recipe.name}"`, isolation));
            }
            let project: ZelavisProjectRecord = {
                ...descriptor,
                capabilities: runtime.capabilities(descriptor),
                ...(isolation ? { isolation } : {}),
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
            return yield* withProjectLifecycle(id, Effect.fn("Projects.provision")(function* () {
            const claim = yield* store.setIfAbsent(PROJECTS_NAMESPACE, id, toStoreValue(project));
            if (!claim.created) {
                return yield* Effect.fail(new ZelavisProjectConflictError(`Project "${id}" already exists.`));
            }
            return yield* Effect.catch(Effect.gen(function* () {
                (yield* runtimeEffects.prepare(project, recipe));
                project = (yield* write({
                    ...project,
                    runtime: { driver: runtime.name, status: "stopped" },
                    updatedAt: new Date().toISOString(),
                }));
                if (input.start === false) return project;
                return yield* startPlaced(id);
            }), Effect.fn("Projects.recover")(function* (error) {
                project = (yield* write({
                    ...project,
                    desiredState: "stopped",
                    runtime: {
                        driver: runtime.name,
                        status: "failed",
                        error: error instanceof Error ? error.message : String(error),
                    },
                    updatedAt: new Date().toISOString(),
                }));
                return (yield* Effect.fail(error));
            }));
            }));
        }),
        update: Effect.fn("Projects.update")(function* (id: Parameters<ZelavisProjectManager["update"]>[0], input: Parameters<ZelavisProjectManager["update"]>[1]) {
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), Effect.fn("Projects.transition")(function* () {
                const project = (yield* requireProject(id));
                (yield* evaluate(() => assertProjectIsOperable(project, "updated")));
                return (yield* write({
                    ...project,
                    name: (yield* evaluate(() => normalizeProjectName(input.name))),
                    updatedAt: new Date().toISOString(),
                }));
            }));
        }),
        start: Effect.fn("Projects.start")(function* (id: Parameters<ZelavisProjectManager["start"]>[0]) {
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), () => startPlaced(id));
        }),
        stop: Effect.fn("Projects.stop")(function* (id: Parameters<ZelavisProjectManager["stop"]>[0]) {
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), Effect.fn("Projects.transition")(function* () {
                let project = (yield* requireProject(id));
                // Stopping a Project that is already being deleted would restart the
                // cleanup lifecycle's work behind it.
                if (project.deletion) yield* evaluate(() => assertProjectIsOperable(project, "stopped"));
                if (project.runtimeUpdate) {
                    project = yield* write({ ...project, desiredState: "stopped", updatedAt: new Date().toISOString() });
                    const stopped = yield* stopPlacedRuntime(project.id);
                    project = yield* recoverProjectUpdate(project);
                    return yield* write(applySnapshot(project, stopped));
                }
                (yield* evaluate(() => assertProjectIsOperable(project, "stopped")));
                project = (yield* write({
                    ...project,
                    desiredState: "stopped",
                    runtime: { driver: runtime.name, status: "stopping" },
                    updatedAt: new Date().toISOString(),
                }));
                return (yield* write(applySnapshot(project, (yield* stopPlacedRuntime(project.id)))));
            }));
        }),
        restart: Effect.fn("Projects.restart")(function* (id: Parameters<ZelavisProjectManager["restart"]>[0]) {
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), Effect.fn("Projects.transition")(function* () {
                let project = (yield* requireProject(id));
                (yield* evaluate(() => assertProjectIsOperable(project, "restarted")));
                // Refused before stopping: a running Project is not taken down only to
                // discover it may not be started again.
                const refusal = isolationRefusal(project) ?? (yield* installRefusal(project));
                if (refusal)
                    return (yield* Effect.fail(refusal));
                if (options.authoritativePlacement) {
                    const assigned = (yield* resolveAssignedNodeElsewhere(project.id));
                    if (assigned) {
                        return (yield* Effect.fail(new ZelavisProjectValidationError(`Project "${project.id}" is placed on node "${assigned}" and cannot restart here.`)));
                    }
                }
                project = (yield* write({
                    ...project,
                    desiredState: "running",
                    runtime: { driver: runtime.name, status: "stopping" },
                    updatedAt: new Date().toISOString(),
                }));
                (yield* stopPlacedRuntime(project.id));
                if (options.authoritativePlacement &&
                    !((yield* ensureCommittedPlacement(project.id, localPlacementNodeId)))) {
                    return (yield* Effect.fail(new ZelavisProjectValidationError(`Project "${project.id}" could not reacquire its local Fabric placement.`)));
                }
                project = (yield* write({
                    ...project,
                    runtime: { driver: runtime.name, status: "starting" },
                    updatedAt: new Date().toISOString(),
                }));
                return (yield* Effect.catch(Effect.gen(function* () {
                    const placement = (yield* localPlacementToken(project.id));
                    (yield* runtimeEffects.prepare(project, project.recipe));
                    return (yield* write(applySnapshot(project, (yield* runtimeEffects.start(project, placement)))));
                }), Effect.fn("Projects.recover")(function* (error) {
                    const failed = {
                        ...project,
                        runtime: {
                            driver: runtime.name,
                            status: "failed" as const,
                            error: error instanceof Error ? error.message : String(error),
                        },
                        updatedAt: new Date().toISOString(),
                    };
                    (yield* write(failed));
                    return (yield* Effect.fail(error));
                })));
            }));
        }),
        upgrade: Effect.fn("Projects.upgrade")(function* (id: Parameters<ZelavisProjectManager["upgrade"]>[0], input: Parameters<ZelavisProjectManager["upgrade"]>[1]) {
            if (input?.restart === true) {
                const current = yield* requireProject(yield* evaluate(() => normalizeProjectId(id)));
                const liveCapable = runtime.supportsLiveUpdate?.(current) === true &&
                    runtimeEffects.prepareUpdate && runtimeEffects.applyUpdate && runtimeEffects.recoverUpdate;
                const managedIntegration = runtime.capabilities(current).recipeUpdateMode === "integration";
                // Only a running Project that cannot be upgraded where it stands is taken down for it.
                if (current.runtime.status === "running" && !liveCapable && !managedIntegration) {
                    yield* manager.stop(current.id);
                    const upgrade = yield* Effect.exit(manager.upgrade(current.id, { ...input, restart: false }));
                    // It was running, so it runs again: the upgraded Project, or the one it was if the upgrade failed.
                    const started = yield* Effect.exit(manager.start(current.id));
                    if (Exit.isFailure(upgrade)) return yield* Effect.failCause(upgrade.cause);
                    if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause);
                    return started.value;
                }
            }
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), Effect.fn("Projects.transition")(function* () {
                let project = yield* requireProject(id);
                // A deletion tombstone always wins over recovery of an update.
                if (project.deletion) yield* evaluate(() => assertProjectIsOperable(project, "upgraded"));
                const interrupted = project.runtimeUpdate;
                project = yield* recoverProjectUpdate(project);
                (yield* evaluate(() => assertProjectIsOperable(project, "upgraded")));
                if (input?.engineVersion !== undefined && project.placement)
                    return yield* Effect.fail(new ZelavisProjectConflictError("Version selection requires the Project's local runtime catalog."));
                if (interrupted && project.recipe.name === interrupted.target.recipe.name && project.recipe.version === interrupted.target.recipe.version &&
                    (input?.engineVersion === undefined || project.engineVersion === input.engineVersion)) return project;
                const live = project.runtime.status === "running" && runtime.supportsLiveUpdate?.(project) === true &&
                    runtimeEffects.prepareUpdate && runtimeEffects.applyUpdate && runtimeEffects.recoverUpdate;
                const integrationUpdate = runtime.capabilities(project).recipeUpdateMode === "integration" &&
                    runtimeEffects.prepareUpdate && runtimeEffects.applyUpdate && runtimeEffects.recoverUpdate;
                if (!live && !["stopped", "failed"].includes(project.runtime.status)) {
                    return (yield* Effect.fail(new ZelavisProjectConflictError(`Project "${project.id}" is ${project.runtime.status}. Stop it before upgrading its recipe.`)));
                }
                const targetName = input?.recipeName?.trim() || project.recipe.name;
                const entry = projectRecipeMap.get(targetName);
                if (!entry) {
                    return (yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${targetName}" is not shipped with this Platform.` +
                        (input?.recipeName ? "" : " Name the recipe to move this Project to."))));
                }
                // A frontend stays a frontend and an app stays an app; a Project's kind
                // label follows its recipe's name, so it is re-derived below.
                if ((entry.service.kind === "frontend") !== (project.kind === "frontend")) {
                    return (yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${targetName}" makes a different kind of Project than "${project.id}" (${project.kind}).`)));
                }
                let next = (yield* evaluate(() => recipeLockFromRegistryEntry(entry)));
                // The install method and software version are the Project's own choice, made at creation.
                // A newer recipe keeps them when it still offers them; otherwise the upgrade is refused.
                const manifest = entry.service.project?.install;
                if (project.recipe.install) {
                    const kept = project.recipe.install;
                    const offered = manifest?.methods.some((method) => method.id === kept.method && method.driver === kept.driver) &&
                        manifest.software.some((software) => software.version === kept.software);
                    if (!offered) {
                        return (yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${next.name}@${next.version}" no longer offers the "${kept.method}" method with software ${kept.software} this Project uses. Create a new Project to use it.`)));
                    }
                    next = { ...next, install: kept };
                } else if (manifest) {
                    // An older layout of the same recipe can be adopted: its folders are moved, not converted.
                    if (!manifest.adopt?.length) {
                        return (yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${next.name}@${next.version}" installs through methods this Project was not created with, and does not describe how to take over its files. Create a new Project to use it.`)));
                    }
                    const install = yield* selectInstall(entry, {});
                    if (install) next = { ...next, install };
                }
                if (input?.engineVersion !== undefined) yield* evaluate(() => readEngineVersion(input as unknown as Record<string, unknown>));
                const selection = yield* (runtimeEffects.resolveVersion?.({ ...project, recipe: next }, input?.engineVersion) ?? Effect.succeed(undefined));
                if (input?.engineVersion !== undefined && !selection)
                    return yield* Effect.fail(new ZelavisProjectValidationError("Engine version selection requires an installed native Zelavis App."));
                if (selection) next = selection.recipe;
                if (!next.runtimeKinds.includes(project.runtimeKind)) {
                    return (yield* Effect.fail(new ZelavisProjectValidationError(`Project recipe "${next.name}" does not support the "${project.runtimeKind}" runtime this Project uses.`)));
                }
                if (next.name === project.recipe.name &&
                    next.version === project.recipe.version &&
                    project.recipe.artifact && (!selection || project.engineVersion === selection.engineVersion)) {
                    return (yield* Effect.fail(new ZelavisProjectConflictError(`Project "${project.id}" already runs ${next.name}@${next.version}.`)));
                }
                const candidate: ZelavisProjectRecord = {
                    ...project,
                    kind: projectKindForRecipe(next.name),
                    recipe: next,
                    ...(selection ? { engineVersion: selection.engineVersion } : {}),
                };
                // Refused before anything changes: an upgrade that would leave the
                // Project unable to start under its isolation intent is not an upgrade.
                const refusal = isolationRefusal(candidate);
                if (refusal)
                    return (yield* Effect.fail(refusal));
                // Freeze the new recipe first. The driver replaces the old artifact only
                // once the new one is complete, so a failure here leaves the Project
                // exactly as it was.
                const now = new Date().toISOString();
                const isolation = assessIsolation(candidate);
                const upgraded: ZelavisProjectRecord = {
                    ...candidate,
                    capabilities: runtime.capabilities(candidate),
                    ...(isolation ? { isolation } : {}),
                    recipeStatus: recipeStatusOf(next),
                    recipeHistory: [
                        ...(project.recipeHistory ?? []),
                        {
                            from: { name: project.recipe.name, version: project.recipe.version },
                            upgradedAt: now,
                        },
                    ].slice(-10),
                    // The reason it could not start belonged to the old lock.
                    runtime: { driver: runtime.name, status: "stopped" },
                    updatedAt: now,
                };
                if (!live && !integrationUpdate) {
                    const previousEngine = selection ? (yield* (runtimeEffects.versions?.(project) ?? Effect.succeed(undefined)))?.current : undefined;
                    yield* runtimeEffects.prepare(candidate, next);
                    return yield* write({ ...upgraded, capabilities: runtime.capabilities(candidate) }).pipe(
                        Effect.tap(() => (runtimeEffects.commitUpgrade?.(project.id) ?? Effect.void).pipe(Effect.orElseSucceed(() => undefined))),
                        Effect.onError(() => Effect.gen(function* () {
                            // Whatever the driver moved to prepare the new recipe goes back before anything else.
                            yield* (runtimeEffects.abandonUpgrade?.(project.id) ?? Effect.void).pipe(Effect.orElseSucceed(() => undefined));
                            // And the earlier recipe is prepared again, which restores the frozen copy and descriptor the
                            // failed upgrade replaced; the original failure is the one reported.
                            yield* runtimeEffects.prepare(previousEngine ? { ...project, engineVersion: previousEngine } : project, project.recipe)
                                .pipe(Effect.orElseSucceed(() => undefined));
                        })));
                }
                const execution = yield* runtimeEffects.prepareUpdate!(project, candidate, live ? (yield* localPlacementToken(project.id)) : undefined);
                upgraded.recipe = execution.recipe;
                upgraded.capabilities = runtime.capabilities(upgraded);
                upgraded.runtime = project.runtime;
                const intent: ZelavisProjectRuntimeUpdateIntent = { id: crypto.randomUUID(), startedAt: now, execution,
                    previous: { kind: project.kind, recipe: project.recipe, recipeHistory: project.recipeHistory, engineVersion: project.engineVersion },
                    target: { kind: upgraded.kind, recipe: upgraded.recipe, recipeHistory: upgraded.recipeHistory, engineVersion: upgraded.engineVersion } };
                yield* write({ ...project, runtimeUpdate: intent });
                return yield* Effect.gen(function* () {
                    const snapshot = yield* runtimeEffects.applyUpdate!(project.id, execution, choice => present(write({
                        ...(choice === "target" ? upgraded : project), runtimeUpdate: intent,
                    }).pipe(Effect.asVoid)));
                    upgraded.capabilities = runtime.capabilities(upgraded);
                    if (execution.mode === "integration") return yield* write({ ...upgraded, runtime: { ...project.runtime, ...snapshot } });
                    return yield* write(applySnapshot(upgraded, snapshot));
                }).pipe(Effect.onError(cause => Effect.gen(function* () {
                    const latest = yield* requireProject(project.id);
                    const recovery = yield* Effect.result(recoverProjectUpdate(latest));
                    if (recovery._tag === "Failure") yield* write({ ...latest, runtimeUpdate: { ...intent, error: String(Cause.squash(cause)).slice(0, 4000) } });
                }).pipe(Effect.orDie)));
            }));
        }),
        logs: Effect.fn("Projects.logs")(function* (id: Parameters<ZelavisProjectManager["logs"]>[0]) {
            yield* requireProject(id);
            return yield* runtimeEffects.logs((yield* evaluate(() => normalizeProjectId(id))));
        }),
        gatewayTarget: Effect.fn("Projects.gatewayTarget")(function* (id: string) {
            return yield* withProjectLifecycle((yield* evaluate(() => normalizeProjectId(id))), () => Effect.gen(function* () {
                const project = yield* requireProject(id);
                yield* evaluate(() => assertProjectIsOperable(project, "accessed"));
                if (project.runtime.status !== "running") return undefined;
                return runtimeEffects.gatewayTarget
                    ? yield* runtimeEffects.gatewayTarget(project, yield* localPlacementToken(id))
                    : project.runtime.url;
            }));
        }),
        signGatewayAuthority: Effect.fn("Projects.signGatewayAuthority")(function* (projectId: Parameters<ZelavisProjectManager["signGatewayAuthority"]>[0], claims: Parameters<ZelavisProjectManager["signGatewayAuthority"]>[1]) {
            if (!runtimeEffects.signGatewayAuthority) return undefined;
            return yield* runtimeEffects.signGatewayAuthority((yield* evaluate(() => normalizeProjectId(projectId))), claims);
        }),
        remove: Effect.fn("Projects.remove")(function* (id: Parameters<ZelavisProjectManager["remove"]>[0]) {
            const projectId = yield* evaluate(() => normalizeProjectId(id));
            return yield* singleFlight(deletionRuns, projectId, () => withProjectLifecycle(projectId, () => deleteProject(projectId)));
        }),
        reconcile: Effect.fn("Projects.reconcile")(function* () {
            if (closing) return;
            return yield* singleFlight(reconciliationRuns, "fleet", () => Effect.acquireUseRelease(
                Effect.forkIn(reconcileFleet(), lifecycleScope),
                fiber => Fiber.join(fiber).pipe(Effect.catchCause(cause =>
                    // A non-cancellable preparation may fail as shutdown
                    // interrupts its owner, producing a combined failure cause.
                    // Reconciliation is cancelled; resource cleanup still runs
                    // separately and retains its own failures.
                    closing ? Effect.void : Effect.failCause(cause))),
                Fiber.interrupt,
            ));
        }),
        close: Effect.fn("Projects.close")(function* () {
            return yield* singleFlight(closeRuns, "close", Effect.fn("Projects.transition")(function* () {
                closing = true;
                if (reconciliationTimer)
                    clearInterval(reconciliationTimer);
                if (placementRenewal)
                    clearInterval(placementRenewal);
                yield* Scope.close(lifecycleScope, Exit.void);
                const active = reconciliationRuns.get("fleet");
                if (active)
                    (yield* Deferred.await(active).pipe(Effect.ignoreCause));
                (yield* runtimeEffects.close());
                for (const token of runtime.custody?.preserveOnClose() ? [] : ownedPlacements.values()) {
                    if (token.nodeId === localPlacementNodeId) {
                        (yield* Effect.catch(integration(() => options.authoritativePlacement?.release(token)), Effect.fn("Projects.recover")(function* () { return undefined; })));
                    }
                }
            }), true);
        }),
    };
    const placementRenewal = options.authoritativePlacement
        ? setInterval(() => {
            void present(mapWithConcurrency([...ownedPlacements.values()], startupConcurrency, Effect.fn("Projects.transition")(function* (token: ProjectPlacementToken) {
                const renewed = yield* integration(() => options.authoritativePlacement!.renew(token, placementLeaseMs));
                if (!renewed.granted) {
                    ownedPlacements.delete(token.projectId);
                    if (token.nodeId === localPlacementNodeId) {
                        yield* Effect.catch(runtimeEffects.stop(token.projectId), Effect.fn("Projects.recover")(function* () { return undefined; }));
                    }
                }
                else if (token.nodeId !== localPlacementNodeId) {
                    yield* integration(() => options.dispatch?.()?.dispatchLeaseFenced?.(renewed.placement));
                }
            })).pipe(Effect.ignore, Effect.forkIn(lifecycleScope)));
        }, placementLeaseMs / 3)
        : undefined;
    placementRenewal?.unref?.();
    // An old owner may expire after a control-plane restart. Retry boundedly so
    // a blocked Project becomes runnable without an operator pressing Start.
    const reconciliationTimer = options.authoritativePlacement
        ? setInterval(() => { void present(manager.reconcile()).catch(() => undefined); }, 15000)
        : undefined;
    reconciliationTimer?.unref?.();
    if (options.autoReconcile !== false) {
        void present(manager.reconcile()).catch(() => undefined);
    }
    const { runtime: description, ...operations } = manager;
    return Object.assign(presentOperations(operations), { runtime: description });
});
export function createProjectManager(options: ZelavisProjectManagerOptions): Promise<ZelavisProjectManager> {
  return present(makeProjectManager(options));
}
