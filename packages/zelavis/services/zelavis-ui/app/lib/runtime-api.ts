import { readServerSentEvents } from "./sse";

export interface RuntimeServiceMenuDefinition {
  title: string;
  path?: string;
  page?: RuntimeServicePageDefinition;
  pageLabel?: string;
  panelLabel?: string;
  search?: Record<string, string | undefined>;
  order?: number;
  fixed?: boolean;
  fixedOrder?: number;
  fixedActionScope?: "local" | "inherit" | "replace" | "clear";
  sectionLabel?: string;
  disabled?: boolean;
  access?: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[];
  surface?: "platform" | "root" | "core" | "extensions" | "settings";
  dynamicItems?: {
    path: string;
    emptyTitle?: string;
    emptyPath?: string;
    emptySearch?: Record<string, string | undefined>;
  };
  items?: readonly RuntimeServiceMenuDefinition[];
}

export interface RuntimeServiceDynamicMenuResponse {
  items: readonly RuntimeServiceMenuDefinition[];
}

export interface RuntimeService {
  name: string;
  kind?: string;
  /**
   * Whether the operator composed this service or it was installed at runtime.
   * The dashboard sandboxes an extension service's page.
   */
  scope?: "system" | "extension";
  apiPath: string;
  menu?: RuntimeServiceMenuDefinition;
  menus?: readonly RuntimeServiceMenuDefinition[];
}

export interface RuntimeServicePageDefinition {
  id: string;
  title?: string;
  file?: string;
  src: string;
}

export interface RuntimeServiceRegistryMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
  search?: Record<string, string | undefined>;
  order?: number;
  fixed?: boolean;
  fixedOrder?: number;
  fixedActionScope?: "local" | "inherit" | "replace" | "clear";
  sectionLabel?: string;
  disabled?: boolean;
  surface?: "platform" | "root" | "core" | "extensions" | "settings";
  access?: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[];
  dynamicItems?: {
    path: string;
    emptyTitle?: string;
    emptyPath?: string;
    emptySearch?: Record<string, string | undefined>;
  };
  page?: RuntimeServicePageDefinition;
  items?: readonly RuntimeServiceRegistryMenuDefinition[];
}

export interface RuntimeServiceRegistryEntry {
  name: string;
  version?: string;
  kind?: string;
  scope?: "system" | "extension";
  /** API namespace this service owns; the only surface its page may reach. */
  apiPath?: string;
  status: "installed" | "available";
  /** How an available entry is installed: fetched from the allow-list, or switched on where it is. */
  installVia?: "acquire" | "activate";
  source?: "official" | "community";
  /** Who maintains it; `zelavis` for what the Zelavis project publishes. */
  maintainer?: string;
  order?: number;
  marketplace?: {
    title?: string;
    summary?: string;
    description?: string;
    categories?: readonly string[];
    tags?: readonly string[];
  };
  project?: {
    hostPackages?: readonly string[];
    runtimeKinds: readonly RuntimeProjectRuntimeKind[];
    /** What a person can choose at creation, when the recipe offers a choice. */
    install?: RuntimeInstallChoices;
  };
  menu?: RuntimeServiceRegistryMenuDefinition;
  menus?: readonly RuntimeServiceRegistryMenuDefinition[];
}

export interface RuntimeServiceRegistryUpdate {
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export interface RuntimeServiceRegistryCreate {
  specifier?: string;
  file?: File;
  name?: string;
  status?: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

export interface RuntimeServiceActivationResult {
  status: "active" | "pending";
  message?: string;
}

export interface RuntimeServiceActivationCapabilities {
  strategy: "runtime-graph" | "external";
  supportsRuntimeInstall: boolean;
  supportsUploadedSpecifiers: boolean;
  supportsPackageUploads: boolean;
  supportsIsolatedExecution: boolean;
  description?: string;
}

export interface RuntimeServiceActivation {
  mode: "runtime" | "host";
  capabilities: RuntimeServiceActivationCapabilities;
}

export type RuntimeEngine = "node" | "bun" | "deno";

export type RuntimePrincipalType =
  | "anonymous"
  | "user"
  | "service"
  | "system";

export type RuntimeAccessScope =
  | {
      type: "system";
    }
  | {
      type: "project";
      projectId?: string;
      projectIdParam?: string;
    }
  | {
      type: "service";
      serviceName?: string;
      serviceNameParam?: string;
    };

export interface RuntimePrincipalGrant {
  permission: string;
  scope?: RuntimeAccessScope;
}

export interface RuntimePrincipal {
  id: string;
  type: RuntimePrincipalType;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly RuntimePrincipalGrant[];
  metadata?: Record<string, unknown>;
}

export interface RuntimeAccessRequirement {
  authenticated?: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  scope?: RuntimeAccessScope;
}

export interface RuntimeDashboardProjectAccess {
  id: string;
  permissions: readonly string[];
}

export interface RuntimeDashboardAccess {
  mode: "owner" | "customer" | "operator" | "reseller";
  label: string;
  principal: RuntimePrincipal;
  projects?: readonly RuntimeDashboardProjectAccess[];
}

export type RuntimeProjectStatus =
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type RuntimeProjectRuntimeKind = string;

export type RuntimeDeploymentBackendFeatureState =
  | "available"
  | "unavailable"
  | "planned";

export interface RuntimeDeploymentBackendSnapshot {
  id: string;
  title: string;
  enabled: boolean;
  isDefault: boolean;
  executable: boolean;
  capabilities: {
    isolationBoundary: "process" | "os-container" | "microvm";
    filesystemIsolation: RuntimeDeploymentBackendFeatureState;
    processIsolation: RuntimeDeploymentBackendFeatureState;
    networkIsolation: RuntimeDeploymentBackendFeatureState;
    resourceControls: Record<"cpu" | "memory" | "pids" | "disk", RuntimeDeploymentBackendFeatureState>;
    exec: RuntimeDeploymentBackendFeatureState;
    persistentStorage: RuntimeDeploymentBackendFeatureState;
    snapshots: RuntimeDeploymentBackendFeatureState;
    images: RuntimeDeploymentBackendFeatureState;
    description: string;
  };
  detection: {
    state: "ready" | "degraded" | "unavailable";
    installed: boolean;
    healthy: boolean;
    version?: string;
    apiVersion?: string;
    rootless?: boolean;
    checkedAt: string;
    details?: Record<string, string | number | boolean>;
    error?: string;
  };
}

export interface RuntimeDeploymentBackendPolicy {
  defaultBackend: string;
  enabledBackends: readonly string[];
  updatedAt: string;
}

export interface RuntimeProject {
  engineVersion?: string;
  runtimeUpdate?: { id: string; error?: string };
  deletion?: { status: "running" | "failed"; startedAt: string; updatedAt: string; participants: readonly string[]; completedParticipants: readonly string[]; currentParticipant?: string; error?: string };
  preview?: { status: "ready" | "stopped" | "unavailable"; port?: number; error?: string };
  id: string;
  name: string;
  kind: string;
  runtimeKind: RuntimeProjectRuntimeKind;
  recipe: {
    name: string;
    title: string;
    version?: string;
    specifier: string;
    runtimeKinds: readonly RuntimeProjectRuntimeKind[];
    /** Set for a managed app: hosting-style controls and the app's own admin entry. */
    managed?: { adminTitle?: string; adminPath?: string };
  };
  capabilities: RuntimeProjectDriverCapabilities;
  /** How the locked recipe compares with what this Platform ships. */
  recipeStatus?:
    | { state: "current" }
    | { state: "upgradeAvailable"; version: string }
    | { state: "unavailable"; reason: string };
  desiredState: "running" | "stopped";
  runtime: {
    driver: string;
    status: RuntimeProjectStatus;
    url?: string;
    startedAt?: string;
    stoppedAt?: string;
    error?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeProjectDriverInfo {
  driver: string;
  availableKinds: readonly RuntimeProjectRuntimeKind[];
}

export interface RuntimeProjectDriverCapabilities {
  independentRuntimeVersion?: boolean;
  zeroDowntimeUpdates?: boolean;
  recipeUpdateMode?: "engine" | "integration";
  movable: boolean;
  liveMigration: boolean;
  secureIsolation: boolean;
  resourceLimits: boolean;
  persistentFilesystem: boolean;
  statelessRuntimeReplicas: boolean;
  managedStorage: boolean;
  managedDatabase: boolean;
  databaseReplication: boolean;
  tenantPlacement: boolean;
  databaseSharding: boolean;
  runtimeOwnership: "platform-process" | "zelavis-agent";
  survivesControlPlaneRestart: boolean;
  description: string;
}

export type FabricFeatureState = "available" | "planned";

export interface FabricNode {
  id: string;
  status: "ready" | "degraded" | "draining" | "unavailable";
  roles: readonly ("gateway" | "control" | "worker")[];
  runtimeEngine?: string;
  runtimeDriver?: string;
  capacity?: {
    cpuCores?: number;
    memoryBytes?: number;
    diskBytes?: number;
  };
  load?: {
    cpu?: number;
    memory?: number;
    disk?: number;
    diskIo?: number;
    network?: number;
    activeRequests?: number;
    sqliteWritePressure?: number;
    jobPressure?: number;
  };
  labels?: Readonly<Record<string, string>>;
}

export interface FabricProjectPlacement {
  identity: {
    scopeId: string;
    workloadId: string;
    type: "project";
  };
  projectKind: string;
  runtimeNodeId: string;
  databaseNodeId?: string;
  generation: number;
  state: "active" | "preparing" | "moving" | "recovering" | "unavailable";
  runtimeStatus?: string;
}

export interface FabricMigration {
  id: string;
  scope: "project" | "tenant-data";
  projectId: string;
  tenantId?: string;
  sourceNodeId: string;
  destinationNodeId: string;
  expectedGeneration: number;
  state: string;
}

export interface FabricSnapshot {
  authority: {
    scope: "platform" | "project";
    scopeId: string;
    parent?: {
      scope: "platform" | "project";
      scopeId: string;
    };
    capabilities: readonly string[];
  };
  mode: "single-node" | "cluster";
  status: "ready" | "degraded" | "unavailable";
  localNodeId: string;
  nodes: readonly FabricNode[];
  projectPlacements: readonly FabricProjectPlacement[];
  migrations: readonly FabricMigration[];
  features: {
    projectPlacement: FabricFeatureState;
    multiNode: FabricFeatureState;
    automaticBalancing: FabricFeatureState;
    projectMigration: FabricFeatureState;
    zelavisAppDataPlacement: FabricFeatureState;
    replication: FabricFeatureState;
    infrastructureAutoscaling: FabricFeatureState;
  };
}

export function normalizeRuntimeProject(project: RuntimeProject): RuntimeProject {
  return {
    ...project,
    runtimeKind: project.runtimeKind ?? "native",
    recipe: {
      ...project.recipe,
      runtimeKinds: project.recipe.runtimeKinds ?? ["native"],
    },
  };
}

export interface RuntimeInstallChoices {
  methods: readonly { id: string; driver: "js" | "oci"; requires: readonly string[] }[];
  software: readonly { version: string }[];
}

export interface RuntimeProjectRecipe {
  hostPackages?: readonly string[];
  name: string;
  title: string;
  version?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  summary?: string;
  marketplace?: RuntimeServiceRegistryEntry["marketplace"];
  runtimeKinds: readonly RuntimeProjectRuntimeKind[];
}

export interface RuntimeAssistantAction {
  label: string;
  to: string;
}

export interface RuntimeAssistantMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  actions?: readonly RuntimeAssistantAction[];
  /** What the Assistant looked up to answer. */
  activity?: readonly RuntimeAssistantActivity[];
  /** Changes this reply asked to make; see `RuntimeAssistantThread.approvals`. */
  approvalIds?: readonly string[];
  /** Which provider and model wrote the reply. */
  provider?: string;
  createdAt: string;
}

export interface RuntimeAssistantActivity {
  label: string;
  status: "running" | "done" | "refused" | "awaiting";
}

export interface RuntimeAssistantApproval {
  id: string;
  threadId: string;
  label: string;
  target: { kind: string; id: string };
  irreversible: boolean;
  status: "pending" | "running" | "denied" | "expired" | "executed" | "failed";
  expiresAt: string;
  outcome?: string;
}

export interface RuntimeAssistantThread {
  id: string;
  title: string;
  projectId?: string;
  messages: readonly RuntimeAssistantMessage[];
  /** Every change requested in this thread, with its current state. */
  approvals?: readonly RuntimeAssistantApproval[];
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeServiceRegistryMutationResult {
  serviceRegistry: RuntimeServiceRegistryEntry[];
  activation?: RuntimeServiceActivationResult;
}

export type RuntimeCapabilities = Readonly<
  Record<string, { available: boolean; used?: boolean }>
>;

export interface RuntimeConfig {
  name: string;
  rootPath: string;
  configSource?: "embedded" | "endpoint" | "fallback";
  api: {
    prefix: string;
    version: string;
    basePath: string;
  };
  dashboard: {
    title: string;
    clientRoutes: string[];
    assetRoot: string;
  };
  runtime?: {
    engine: RuntimeEngine;
    availableEngines: readonly RuntimeEngine[];
  };
  capabilities?: RuntimeCapabilities;
  services: RuntimeService[];
  serviceRegistry: RuntimeServiceRegistryEntry[];
  serviceActivation?: RuntimeServiceActivation;
  access?: RuntimeDashboardAccess;
}

export interface RuntimeAuthBootstrapStatus {
  required: boolean;
  providers: readonly string[];
  enrollmentProviders: readonly string[];
  available: boolean;
  tokenRequired: boolean;
}

export interface RuntimeAuthSessionResult {
  account: AuthAccount;
  session: {
    token: string;
    session: {
      id: string;
      accountId: string;
      status: "active" | "revoked" | "expired";
      expiresAt: string;
      createdAt: string;
      updatedAt: string;
    };
  };
}

export interface RuntimeEdgeAdapterStatus {
  id: string;
  title: string;
  capabilities: readonly string[];
  detection: {
    state: "available" | "unavailable" | "unhealthy";
    installed: boolean;
    healthy: boolean;
    version?: string;
    detail?: string;
  };
  active: boolean;
  desired: boolean;
}

export interface RuntimeEdgeStatus {
  policy: {
    desiredAdapterId: string;
    activeAdapterId?: string;
  };
  adapters: readonly RuntimeEdgeAdapterStatus[];
  activeSwitch?: {
    id: string;
    targetAdapterId: string;
    phase: string;
    error?: string;
  };
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export type DashboardThemeMode = "light" | "dark" | "auto";

export interface DashboardContentPreferences {
  pinnedTypes?: string[];
  labels?: Record<string, string>;
}

export interface DashboardMediaPreferences {
  orderedPaths?: string[];
}

export interface DashboardPreferences {
  content?: DashboardContentPreferences;
  media?: DashboardMediaPreferences;
}

export interface DashboardSettings {
  rootPath: string;
  pendingRootPath?: string;
  apiBasePath: string;
  runtimeEngine: {
    current: RuntimeEngine;
    desired: RuntimeEngine;
    available: readonly RuntimeEngine[];
    restartRequired: boolean;
  };
  theme: DashboardThemeMode;
  pageBuilderEnabled: boolean;
  preferences: DashboardPreferences;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    runtimeEngine: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}

export interface DashboardSettingsUpdate {
  rootPath?: string;
  runtimeEngine?: RuntimeEngine;
  theme?: DashboardThemeMode;
  pageBuilderEnabled?: boolean;
  preferences?: DashboardPreferences;
}


export interface AuthAccount {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
  grants?: readonly RuntimePrincipalGrant[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuthOAuthConnection {
  provider: string;
  title?: string;
  issuer?: string;
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  enabled: boolean;
  configured: boolean;
  hasClientSecret: boolean;
  updatedAt: string;
}

export interface StorageFile {
  path: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

export interface StorageFileReference {
  kind: "file";
  path: string;
  href: string;
  metadataHref: string;
  size?: number;
  updatedAt?: string;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  metadata?: Record<string, string>;
  checksum?: string;
}

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

export interface WorkloadSaveInput {
  projectId?: string;
  type: WorkloadType;
  name: string;
  code: string;
  route?: string;
  schedule?: string;
  enabled?: boolean;
}

declare global {
  interface Window {
    __ZELAVIS_RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

export interface DatabaseHealth {
  status: string;
  nodeId: string;
}

export const ZELAVIS_APP_ADMIN_TENANT_ID = "zelavis-app";

export type DatabaseCollectionSurface = "content-studio" | "database";

export interface DatabaseCollection {
  name: string;
  tenantId: string;
  createdAt: string;
  documentCount: number;
  surface?: DatabaseCollectionSurface;
  metadata?: Record<string, unknown>;
}

export interface DatabaseDocument {
  id: string;
  tenantId: string;
  collection: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  version: number;
  schemaVersion: number;
}

export type DatabaseSystemViewName =
  | "collections"
  | "events"
  | "schemas"
  | "projections"
  | "time-series";

export interface DatabaseSystemViewRow {
  id: string;
  data: Record<string, unknown>;
}

export interface DatabaseSchemaCollectionSummary {
  collection: string;
  activeVersion: number | null;
  versions: number[];
}

export interface CollectionFieldEntry {
  name: string;
  field: {
    _tag: string;
    label: string;
    required: boolean;
    [key: string]: unknown;
  };
}

export interface DatabaseStoredCollectionSchema {
  collection: string;
  version: number;
  fields: CollectionFieldEntry[];
  active: boolean;
}

export type DatabaseTimeSeriesAggregateOperation =
  | "avg"
  | "sum"
  | "min"
  | "max"
  | "count";

export interface DatabaseTimeSeriesSummary {
  name: string;
  description?: string;
  version?: string | number;
  projection?: string;
}

export interface DatabaseTimeSeriesPoint {
  timestamp: number | string;
  value: number;
  tags?: Record<string, string>;
  fields?: Record<string, unknown>;
}

const fallbackConfig: RuntimeConfig = {
  name: "zelavis",
  rootPath: "",
  api: {
    prefix: "/api",
    version: "v1",
    basePath: "/api/v1",
  },
  dashboard: {
    title: "zelavis",
    clientRoutes: [
      "/server/access",
      "/server/access/permissions",
      "/server/access/users",
      "/assistant",
      "/projects",
      "/resources",
      "/security",
      "/services",
      "/server",
      "/server/backups",
      "/server/domains",
      "/server/logs",
      "/server/runtimes",
      "/settings",
      "/settings/appearance",
      "/projects/:projectId",
      "/projects/:projectId/agents",
      "/projects/:projectId/auth",
      "/projects/:projectId/content",
      "/projects/:projectId/content/new",
      "/projects/:projectId/database",
      "/projects/:projectId/database/new",
      "/projects/:projectId/media",
      "/projects/:projectId/settings",
      "/projects/:projectId/storage",
      "/projects/:projectId/users",
      "/projects/:projectId/website",
      "/projects/:projectId/workloads",
      "/projects/:projectId/workloads/functions",
      "/projects/:projectId/workloads/functions/:workloadId",
      "/projects/:projectId/workloads/jobs",
      "/projects/:projectId/workloads/jobs/:workloadId",
      "/projects/:projectId/workloads/logs",
      "/projects/:projectId/workloads/new",
      "/projects/:projectId/workloads/schedules",
      "/projects/:projectId/workloads/schedules/:workloadId",
      "/projects/:projectId/workloads/settings",
      "/projects/:projectId/workloads/webhooks",
      "/projects/:projectId/workloads/webhooks/:workloadId",
    ],
    assetRoot: "/assets",
  },
  capabilities: {
    server: { available: true },
    fabric: { available: true },
    database: { available: true },
    identity: { available: true },
    storage: { available: true },
    workloads: { available: true },
    site: { available: true },
  },
  services: [],
  serviceRegistry: [],
  serviceActivation: {
    mode: "runtime",
    capabilities: {
      strategy: "runtime-graph",
      supportsRuntimeInstall: true,
      supportsUploadedSpecifiers: true,
      supportsPackageUploads: false,
      supportsIsolatedExecution: false,
      description:
        "Fallback dashboard config models an in-process runtime graph.",
    },
  },
};

const fallbackServicesByName = new Map(
  fallbackConfig.services.map((service) => [service.name, service] as const),
);

function normalizeRuntimeServices(
  services: readonly RuntimeService[],
): RuntimeService[] {
  return services.map((service) => {
    const fallback = fallbackServicesByName.get(service.name);

    return {
      ...fallback,
      ...service,
      apiPath: service.apiPath,
      menu: normalizeRuntimeServiceMenu(
        service.menu ?? fallback?.menu,
        service.name,
      ),
      menus: [
        ...(service.menus ?? []),
        ...((service.menus === undefined && fallback?.menus) ? fallback.menus : []),
      ].map((menu) => normalizeRuntimeServiceMenu(menu, service.name)!),
    };
  });
}

function normalizeRuntimeServiceRegistry(
  services: readonly RuntimeServiceRegistryEntry[],
): RuntimeServiceRegistryEntry[] {
  return services.map((service) => ({
    ...service,
    menu: normalizeRuntimeServiceMenu(service.menu, service.name) as
      | RuntimeServiceRegistryMenuDefinition
      | undefined,
    menus: service.menus?.map(
      (menu) =>
        normalizeRuntimeServiceMenu(
          menu,
          service.name,
        ) as RuntimeServiceRegistryMenuDefinition,
    ),
  }));
}

function normalizeRuntimeServiceMenu<
  TMenu extends RuntimeServiceMenuDefinition | RuntimeServiceRegistryMenuDefinition,
>(
  menu: TMenu | undefined,
  serviceName: string,
  parentSegments: readonly string[] = [],
): TMenu | undefined {
  if (!menu) {
    return undefined;
  }

  const segment = slugifyMenuSegment(menu.title);
  const nextSegments = [...parentSegments, segment];
  const path =
    menu.path ??
    deriveRuntimeServiceMenuPath(serviceName, menu.title, parentSegments);

  return {
    ...menu,
    path,
    dynamicItems: menu.dynamicItems
      ? {
          ...menu.dynamicItems,
          emptyPath: menu.dynamicItems.emptyPath ?? path,
          emptySearch: menu.dynamicItems.emptySearch ?? menu.search,
        }
      : menu.dynamicItems,
    items: menu.items?.map((item) =>
      normalizeRuntimeServiceMenu(item, serviceName, nextSegments),
    ) as TMenu["items"],
  };
}

function slugifyServiceSegment(value: string) {
  return value
    .replace(/^@/, "")
    .replace(/^zelavis\//, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveRuntimeServiceMenuPath(
  serviceName: string,
  title: string,
  parentSegments: readonly string[],
) {
  const serviceSegment = slugifyServiceSegment(serviceName);
  const titleSegment = slugifyMenuSegment(title);
  const segments = [
    (parentSegments.length === 0 && serviceSegment === titleSegment) ||
    parentSegments[0] === serviceSegment
      ? undefined
      : serviceSegment,
    ...parentSegments,
    parentSegments.at(-1) === titleSegment ? undefined : titleSegment,
  ].filter(Boolean);

  return `/${segments.join("/")}`;
}

function slugifyMenuSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const EMPTY_DASHBOARD_PREFERENCES: DashboardPreferences = {};

export function getResolvedDashboardPreferences(
  settings:
    | Pick<DashboardSettings, "preferences">
    | { preferences?: DashboardPreferences }
    | undefined,
): DashboardPreferences {
  return settings?.preferences ?? EMPTY_DASHBOARD_PREFERENCES;
}

function inferRootPath(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const segment = window.location.pathname.split("/").filter(Boolean)[0];
  return segment === "zelavis" ? "/zelavis" : "";
}

function inferFallbackRootPath(rootPath: string): string {
  if (rootPath || typeof window === "undefined") {
    return rootPath;
  }

  return window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
    ? "/zelavis"
    : rootPath;
}

function encodeStoragePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function getStorageFileUrl(config: RuntimeConfig, path: string) {
  return `${config.api.basePath}/storage/files/${encodeStoragePath(path)}`
}

export function isRenderableImageFile(file: {
  contentType?: string;
  path: string;
}) {
  const contentType = file.contentType?.toLowerCase()
  if (contentType?.startsWith('image/')) {
    return true
  }

  return /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(file.path)
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (!(init?.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Request failed for ${path}: ${message}`);
  }

  if (!response.ok) {
    let message = `Request failed: ${response.status}`;

    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await response.json()) as {
          error?: unknown;
          correlationId?: unknown;
        };
        if (typeof body.error === "string" && body.error.length > 0) {
          message = body.error;
          if (
            typeof body.correlationId === "string" &&
            /^[0-9a-f]{16}$/.test(body.correlationId)
          ) {
            message += ` Reference: ${body.correlationId}.`;
          }
        }
      } else if (response.status === 404) {
        message =
          "Zelavis API route was not found. If you are using the UI dev server, start the Node.js example and restart the UI dev server.";
      }
    } catch {
      // An HTML/non-JSON response still produces an explicit HTTP status error.
      message = `Request failed: ${response.status}`;
    }

    throw new RuntimeApiError(`${message} (${path})`, response.status, path);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function joinApiPath(basePath: string, path: string) {
  const normalizedBase = basePath.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");

  return `${normalizedBase}/${normalizedPath}`;
}

function hasDynamicItems(menu: RuntimeServiceMenuDefinition | undefined): boolean {
  if (!menu) {
    return false;
  }

  if (menu.dynamicItems) {
    return true;
  }

  return Boolean(menu.items?.some(hasDynamicItems));
}

async function resolveDynamicMenuItems(
  config: RuntimeConfig,
  menu: RuntimeServiceMenuDefinition,
): Promise<RuntimeServiceMenuDefinition> {
  const [staticItems, dynamicItems] = await Promise.all([
    Promise.all(
      (menu.items ?? []).map((item) =>
        resolveDynamicMenuItems(config, item),
      ),
    ),
    menu.dynamicItems
      ? readJson<RuntimeServiceDynamicMenuResponse>(
          joinApiPath(config.api.basePath, menu.dynamicItems.path),
        )
          .then((result) => normalizeDynamicMenuItems(result.items, menu.path))
          .catch(() => [] as RuntimeServiceMenuDefinition[])
      : Promise.resolve([] as RuntimeServiceMenuDefinition[]),
  ]);

  return {
    ...menu,
    items: [
      ...staticItems,
      ...(dynamicItems.length > 0
        ? dynamicItems
        : menu.dynamicItems?.emptyTitle
          ? [
              {
                title: menu.dynamicItems.emptyTitle,
                path: menu.dynamicItems.emptyPath ?? menu.path,
                search: menu.dynamicItems.emptySearch ?? menu.search,
                pageLabel: menu.pageLabel,
                disabled: !(menu.dynamicItems.emptyPath ?? menu.path),
              },
            ]
          : []),
    ],
  };
}

function normalizeDynamicMenuItems(
  items: readonly RuntimeServiceMenuDefinition[],
  parentPath: string | undefined,
): RuntimeServiceMenuDefinition[] {
  return items.map((item) => {
    const path =
      item.path ??
      (parentPath
        ? `${parentPath.replace(/\/$/, "")}/${slugifyMenuSegment(item.title)}`
        : undefined);

    return {
      ...item,
      path,
      dynamicItems: item.dynamicItems
        ? {
            ...item.dynamicItems,
            emptyPath: item.dynamicItems.emptyPath ?? path,
            emptySearch: item.dynamicItems.emptySearch ?? item.search,
          }
        : item.dynamicItems,
      items: item.items
        ? normalizeDynamicMenuItems(item.items, path)
        : item.items,
    };
  });
}

async function resolveRuntimeServiceDynamicMenu(
  config: RuntimeConfig,
  service: RuntimeService,
): Promise<RuntimeService> {
  if (!hasDynamicItems(service.menu) && !service.menus?.some(hasDynamicItems)) {
    return service;
  }

  return {
    ...service,
    menu: service.menu
      ? await resolveDynamicMenuItems(config, service.menu)
      : service.menu,
    menus: service.menus
      ? await Promise.all(
          service.menus.map((menu) =>
            hasDynamicItems(menu) ? resolveDynamicMenuItems(config, menu) : menu,
          ),
        )
      : service.menus,
  };
}

async function resolveRuntimeRegistryDynamicMenu(
  config: RuntimeConfig,
  service: RuntimeServiceRegistryEntry,
): Promise<RuntimeServiceRegistryEntry> {
  if (!hasDynamicItems(service.menu) && !service.menus?.some(hasDynamicItems)) {
    return service;
  }

  return {
    ...service,
    menu: service.menu
      ? (await resolveDynamicMenuItems(
          config,
          service.menu,
        )) as RuntimeServiceRegistryMenuDefinition
      : service.menu,
    menus: service.menus
      ? await Promise.all(
          service.menus.map((menu) =>
            hasDynamicItems(menu)
              ? (resolveDynamicMenuItems(
                  config,
                  menu,
                ) as Promise<RuntimeServiceRegistryMenuDefinition>)
              : menu,
          ),
        )
      : service.menus,
  };
}

export async function resolveRuntimeDynamicMenus(
  config: RuntimeConfig,
): Promise<RuntimeConfig> {
  const [services, serviceRegistry] = await Promise.all([
    Promise.all(
      config.services.map((service) =>
        resolveRuntimeServiceDynamicMenu(config, service),
      ),
    ),
    Promise.all(
      config.serviceRegistry.map((service) =>
        resolveRuntimeRegistryDynamicMenu(config, service),
      ),
    ),
  ]);

  return {
    ...config,
    services,
    serviceRegistry,
  };
}

let _runtimeConfigCache: Promise<RuntimeConfig> | undefined;

async function _fetchRuntimeConfig(): Promise<RuntimeConfig> {
  if (typeof window !== "undefined" && window.__ZELAVIS_RUNTIME_CONFIG__) {
    return {
      ...window.__ZELAVIS_RUNTIME_CONFIG__,
      services: normalizeRuntimeServices(
        window.__ZELAVIS_RUNTIME_CONFIG__.services ?? [],
      ),
      serviceRegistry: normalizeRuntimeServiceRegistry(
        window.__ZELAVIS_RUNTIME_CONFIG__.serviceRegistry ?? [],
      ),
      configSource: "embedded",
    };
  }

  const rootPath = inferRootPath();
  const fallbackRootPath = inferFallbackRootPath(rootPath);

  try {
    const config = await readJson<RuntimeConfig>(
      `${rootPath}/api/v1/runtime/config`,
    );
    return {
      ...config,
      services: normalizeRuntimeServices(config.services ?? []),
      serviceRegistry: normalizeRuntimeServiceRegistry(config.serviceRegistry ?? []),
      configSource: "endpoint",
    };
  } catch {
    return {
      ...fallbackConfig,
      configSource: "fallback",
      rootPath: fallbackRootPath,
      api: {
        ...fallbackConfig.api,
        basePath: `${fallbackRootPath}/api/v1`,
      },
      services: normalizeRuntimeServices(
        fallbackConfig.services.map((service) => ({
          ...service,
          apiPath:
            service.name === "@zelavis/ui"
              ? fallbackRootPath || "/"
              : `${fallbackRootPath}${service.apiPath}`,
        })),
      ),
      serviceRegistry: normalizeRuntimeServiceRegistry(
        fallbackConfig.serviceRegistry ?? [],
      ),
    };
  }
}

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  _runtimeConfigCache ??= _fetchRuntimeConfig();
  return _runtimeConfigCache;
}

/**
 * Deferred rendezvous for the current navigation's resolved runtime config.
 *
 * The root loader calls `beginNavigationRuntimeResolve` **synchronously**
 * at the very start of its function body (before any `await`).  This creates
 * a deferred promise keyed by the current project ID.
 *
 * Child route `clientLoader` / `clientAction` functions call
 * `getActiveRuntimeConfig(request)`, which finds and awaits that deferred.
 *
 * After the root loader determines the correct runtime config (checking
 * project existence, running status, proxy resolution), it calls
 * the returned handle's `commit(config)` to resolve the deferred.
 *
 * Because React Router calls matched `clientLoader` functions synchronously
 * in route-match order (root first), the deferred is always created before
 * child loaders execute their synchronous body.
 */
type ActiveRuntimeConfig = RuntimeConfig & { readonly project?: RuntimeProject };

let _navigationDeferred: {
  projectId: string;
  promise: Promise<ActiveRuntimeConfig>;
  resolve: (config: ActiveRuntimeConfig) => void;
  reject: (error: unknown) => void;
} | undefined;

/**
 * Create the deferred promise for the current navigation.
 * Must be called **synchronously** (before any `await`) in the root loader.
 */
export function beginNavigationRuntimeResolve(
  projectId: string | undefined,
  signal: AbortSignal,
) {
  let resolve!: (config: ActiveRuntimeConfig) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ActiveRuntimeConfig>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  void promise.catch(() => undefined);
  _navigationDeferred = projectId ? { projectId, promise, resolve, reject } : undefined;
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    commit(config: RuntimeConfig, project?: RuntimeProject) {
      signal.removeEventListener("abort", abort);
      resolve({ ...config, ...(project ? { project } : {}) });
    },
    reject(error: unknown) {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
  };
}

/**
 * Returns the runtime config scoped to the current context.
 *
 * When inside a project URL (`/projects/:projectId/`), this awaits the
 * deferred promise that the root loader set up, ensuring child loaders
 * use the same correctly-resolved config as the root.
 * Outside a project context this returns `getRuntimeConfig()`.
 */
export async function getActiveRuntimeConfig(
  request: Request,
): Promise<ActiveRuntimeConfig> {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/(?:^|\/)projects\/([^/]+)/);
  const projectId = match?.[1] ? decodeURIComponent(match[1]) : undefined;

  if (!projectId) {
    return getRuntimeConfig();
  }

  if (_navigationDeferred?.projectId === projectId) {
    return _navigationDeferred.promise;
  }

  const controlConfig = await getRuntimeConfig();
  const [config, project] = await Promise.all([
    getProjectRuntimeConfig(controlConfig, projectId),
    listProjects(controlConfig).then(result => result.projects.find(project => project.id === projectId)),
  ]);
  return { ...config, project };
}

export async function getDashboardAccess(
  config: RuntimeConfig,
): Promise<RuntimeDashboardAccess> {
  return readJson<RuntimeDashboardAccess>(
    `${config.api.basePath}/runtime/access`,
  );
}

export async function getAuthBootstrapStatus(
  config: RuntimeConfig,
): Promise<RuntimeAuthBootstrapStatus> {
  return readJson<RuntimeAuthBootstrapStatus>(
    `${config.api.basePath}/auth/bootstrap`,
  );
}

export async function bootstrapPlatformOwner(
  config: RuntimeConfig,
  input: {
    bootstrapToken: string;
    provider: string;
    account: { email?: string; username?: string; displayName?: string };
    credential: { identifier: string; password: string };
  },
): Promise<RuntimeAuthSessionResult> {
  return readJson<RuntimeAuthSessionResult>(
    `${config.api.basePath}/auth/bootstrap`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function getEdgeStatus(
  config: RuntimeConfig,
): Promise<RuntimeEdgeStatus> {
  return readJson<RuntimeEdgeStatus>(`${config.api.basePath}/runtime/edge`);
}

export async function preflightEdgeHostname(
  config: RuntimeConfig,
  hostname: string,
): Promise<{ hostname: string; valid: boolean; dnsResolved: boolean; addresses?: readonly string[]; error?: string }> {
  return readJson(`${config.api.basePath}/runtime/edge/onboard/preflight?hostname=${encodeURIComponent(hostname)}`);
}

export async function onboardEdgeHostname(
  config: RuntimeConfig,
  input: { mode: "managed" | "external" | "later"; hostname?: string },
): Promise<{ mode: string; status: string; hostname?: string; canonicalUrl?: string; error?: string }> {
  return readJson(`${config.api.basePath}/runtime/edge/onboard`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function authenticatePlatform(
  config: RuntimeConfig,
  provider: string,
  input: { identifier: string; password: string },
): Promise<RuntimeAuthSessionResult> {
  return readJson<RuntimeAuthSessionResult>(
    `${config.api.basePath}/auth/authenticate/${encodeURIComponent(provider)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function logoutPlatform(config: RuntimeConfig): Promise<void> {
  const response = await fetch(`${config.api.basePath}/auth/session`, {
    method: "DELETE",
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok && response.status !== 401) {
    throw new RuntimeApiError(
      `Logout failed: ${response.status}`,
      response.status,
      `${config.api.basePath}/auth/session`,
    );
  }
}

export async function listProjects(
  config: RuntimeConfig,
): Promise<{ runtime: RuntimeProjectDriverInfo; projects: RuntimeProject[] }> {
  const result = await readJson<{
    runtime: RuntimeProjectDriverInfo;
    projects: RuntimeProject[];
  }>(
    `${config.api.basePath}/runtime/projects`,
  );
  return {
    runtime: {
      ...result.runtime,
      availableKinds: result.runtime.availableKinds ?? ["native"],
    },
    projects: result.projects.map(normalizeRuntimeProject),
  };
}

export async function listProjectRecipes(
  config: RuntimeConfig,
): Promise<RuntimeProjectRecipe[]> {
  const result = await readJson<{ projectRecipes: RuntimeProjectRecipe[] }>(
    `${config.api.basePath}/runtime/project-recipes`,
  );
  return result.projectRecipes;
}

export async function listAssistantThreads(
  config: RuntimeConfig,
  projectId?: string,
): Promise<{ responder: string; threads: RuntimeAssistantThread[] }> {
  const search = projectId
    ? `?projectId=${encodeURIComponent(projectId)}`
    : "";
  return readJson<{ responder: string; threads: RuntimeAssistantThread[] }>(
    `${config.api.basePath}/runtime/assistant/threads${search}`,
  );
}

export async function getAssistantThread(
  config: RuntimeConfig,
  threadId: string,
): Promise<RuntimeAssistantThread> {
  const result = await readJson<{
    thread: RuntimeAssistantThread;
    approvals?: readonly RuntimeAssistantApproval[];
  }>(`${config.api.basePath}/runtime/assistant/threads/${encodeURIComponent(threadId)}`);
  return { ...result.thread, approvals: result.approvals ?? [] };
}

export async function decideAssistantApproval(
  config: RuntimeConfig,
  threadId: string,
  approvalId: string,
  decision: "approve" | "deny",
  confirm?: string,
): Promise<{ approval: RuntimeAssistantApproval; message: RuntimeAssistantMessage }> {
  return readJson(
    `${config.api.basePath}/runtime/assistant/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: "POST", body: JSON.stringify({ decision, ...(confirm ? { confirm } : {}) }) },
  );
}

export async function createAssistantThread(
  config: RuntimeConfig,
  input: { title?: string; projectId?: string } = {},
): Promise<RuntimeAssistantThread> {
  const result = await readJson<{ thread: RuntimeAssistantThread }>(
    `${config.api.basePath}/runtime/assistant/threads`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return result.thread;
}

export async function sendAssistantMessage(
  config: RuntimeConfig,
  threadId: string,
  content: string,
): Promise<{
  thread: RuntimeAssistantThread;
  userMessage: RuntimeAssistantMessage;
  assistantMessage: RuntimeAssistantMessage;
}> {
  return readJson(
    `${config.api.basePath}/runtime/assistant/threads/${encodeURIComponent(threadId)}/messages`,
    { method: "POST", body: JSON.stringify({ content }) },
  );
}

export type AssistantStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; label: string; status: "running" | "done" | "refused" | "awaiting" }
  | {
      type: "approval";
      id: string;
      label: string;
      irreversible: boolean;
      target: { kind: string; id: string };
    }
  | {
      type: "done";
      thread: RuntimeAssistantThread;
      userMessage: RuntimeAssistantMessage;
      assistantMessage: RuntimeAssistantMessage;
    }
  | { type: "error"; message: string };

/**
 * Posts a message and yields the reply as it is written. Refusals that happen
 * before the stream opens (no such thread, no access, empty message) throw with
 * their real status; anything after that arrives as an `error` event.
 */
export async function* streamAssistantMessage(
  config: RuntimeConfig,
  threadId: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<AssistantStreamEvent> {
  const path = `${config.api.basePath}/runtime/assistant/threads/${encodeURIComponent(threadId)}/messages/stream`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ content }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Request failed for ${path}`);
  }
  if (!response.ok || !response.body) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      message = `Request failed: ${response.status}`;
    }
    throw new RuntimeApiError(`${message} (${path})`, response.status, path);
  }
  for await (const frame of readServerSentEvents(response.body)) {
    yield { ...(frame.data as object), type: frame.event } as AssistantStreamEvent;
  }
}

/**
 * The Platform packages that contribute to a Project's navigation.
 *
 * Project runtimes are headless and do not carry the Platform's own packages,
 * yet a Project's navigation still offers what the operator composed for it
 * (Marketplace, Auth settings). The contract is the menu's declared `surface`:
 * `platform` belongs to the global shell and never crosses into a Project,
 * while `root`, `core`, `extensions` and `settings` are Project surfaces. Only
 * `system`-scope packages qualify; the Platform strips the surface from
 * anything an operator did not compose, so an extension cannot claim one. A
 * contributing package keeps its Platform API path rather than being proxied
 * into the Project, and a Project's own package of the same name wins.
 */
export function selectPlatformProjectServices(
  platformServices: readonly RuntimeService[],
  projectServiceNames: ReadonlySet<string>,
): RuntimeService[] {
  return platformServices
    .filter(
      (service) =>
        service.scope === "system" &&
        service.name !== "@zelavis/ui" &&
        !projectServiceNames.has(service.name),
    )
    .flatMap((service) => {
      const menus = [...(service.menus ?? (service.menu ? [service.menu] : []))].filter(
        (menu) => menu.surface !== undefined && menu.surface !== "platform",
      );
      return menus.length === 0 ? [] : [{ ...service, menu: menus[0], menus }];
    });
}

export async function getProjectRuntimeConfig(
  controlConfig: RuntimeConfig,
  projectId: string,
): Promise<RuntimeConfig> {
  const proxyRoot = `${controlConfig.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
  const projectConfig = await readJson<RuntimeConfig>(
    `${proxyRoot}/zelavis/api/v1/runtime/config`,
  );
  const projectApiBasePath = `${proxyRoot}${projectConfig.api.basePath}`;

  const projectMenu = (menu: RuntimeServiceMenuDefinition, version?: string): RuntimeServiceMenuDefinition => ({ ...menu,
    ...(menu.page ? { page: { ...menu.page, src: menu.page.src.startsWith(`${projectConfig.rootPath}/`)
      ? `${proxyRoot}${menu.page.src}${version ? `${menu.page.src.includes("?") ? "&" : "?"}zelavisServiceVersion=${encodeURIComponent(version)}` : ""}` : menu.page.src } } : {}),
    ...(menu.items ? { items: menu.items.map(item => projectMenu(item, version)) } : {}),
  });
  const projectServices = normalizeRuntimeServices(
    (projectConfig.services ?? [])
      .filter(
        (service) =>
          service.name !== "@zelavis/ui" &&
          service.name !== "@zelavis/ui:app",
      )
      .map((service) => ({
        ...service,
        ...(service.menu ? { menu: projectMenu(service.menu, projectConfig.serviceRegistry?.find(entry => entry.name === service.name)?.version) } : {}),
        ...(service.menus ? { menus: service.menus.map(menu => projectMenu(menu, projectConfig.serviceRegistry?.find(entry => entry.name === service.name)?.version)) } : {}),
        apiPath: service.apiPath.startsWith(projectConfig.rootPath)
          ? `${proxyRoot}${service.apiPath}`
          : service.apiPath,
      })),
  );
  const platformProjectServices = selectPlatformProjectServices(
    controlConfig.services,
    new Set(projectServices.map((service) => service.name)),
  );

  return {
    ...projectConfig,
    rootPath: controlConfig.rootPath,
    configSource: "endpoint",
    api: {
      ...projectConfig.api,
      basePath: projectApiBasePath,
    },
    dashboard: controlConfig.dashboard,
    services: [...projectServices, ...platformProjectServices],
    serviceRegistry: normalizeRuntimeServiceRegistry(
      (projectConfig.serviceRegistry ?? []).map(entry => ({ ...entry, ...(entry.menu ? { menu: projectMenu(entry.menu, entry.version) } : {}) })),
    ),
  };
}

export async function createProject(
  config: RuntimeConfig,
  input: {
    name: string;
    id?: string;
    recipeName?: string;
    engineVersion?: string;
    method?: string;
    softwareVersion?: string;
    start?: boolean;
    installHostPackages?: boolean;
  },
): Promise<RuntimeProject> {
  const result = await readJson<{ project: RuntimeProject }>(
    `${config.api.basePath}/runtime/projects`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return normalizeRuntimeProject(result.project);
}

export async function setProjectRunning(
  config: RuntimeConfig,
  projectId: string,
  running: boolean,
): Promise<RuntimeProject> {
  const result = await readJson<{ project: RuntimeProject }>(
    `${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/${running ? "start" : "stop"}`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return normalizeRuntimeProject(result.project);
}

export interface RuntimeProjectVersions {
  current?: string;
  latest?: string;
  selectable: boolean;
  reason?: string;
  versions: readonly { version: string; status: "available" | "unavailable"; error?: string; nodeVersion?: string }[];
}

export function getProjectVersions(config: RuntimeConfig, projectId?: string): Promise<RuntimeProjectVersions> {
  const path = projectId ? `/runtime/projects/${encodeURIComponent(projectId)}/versions` : "/runtime/project-versions";
  return readJson(`${config.api.basePath}${path}`);
}

export interface RuntimeProjectSetupValue {
  id: string;
  label: string;
  secret: boolean;
  value?: string;
}

/** What the application's own installer asks for; a secret carries no value. */
export function getProjectSetup(config: RuntimeConfig, projectId: string): Promise<readonly RuntimeProjectSetupValue[]> {
  return readJson<{ values: readonly RuntimeProjectSetupValue[] }>(`${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/setup`).then(result => result.values);
}

export interface RuntimeProjectSetupReveal {
  at: number;
  principalId: string;
  principalType: string;
  revealed: readonly string[];
}

/** Who revealed the secrets, newest first; needs `project.setup.reveal`. */
export function getProjectSetupReveals(config: RuntimeConfig, projectId: string): Promise<readonly RuntimeProjectSetupReveal[]> {
  return readJson<{ reveals: readonly RuntimeProjectSetupReveal[] }>(`${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/setup/audit`).then(result => result.reveals);
}

/** The same with secrets, audited by the Platform; needs `project.setup.reveal`. */
export function revealProjectSetup(config: RuntimeConfig, projectId: string): Promise<readonly RuntimeProjectSetupValue[]> {
  return readJson<{ values: readonly RuntimeProjectSetupValue[] }>(`${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/setup/reveal`, { method: "POST" }).then(result => result.values);
}

export function switchProjectVersion(config: RuntimeConfig, projectId: string, version: string): Promise<RuntimeProject> {
  return readJson<{ project: RuntimeProject }>(`${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/version`,
    { method: "POST", body: JSON.stringify({ version }) }).then(result => normalizeRuntimeProject(result.project));
}

/** Re-locks a stopped Project to a recipe this Platform ships; its data is kept. */
export async function upgradeProject(
  config: RuntimeConfig,
  projectId: string,
  recipeName?: string,
): Promise<RuntimeProject> {
  const result = await readJson<{ project: RuntimeProject }>(
    `${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/upgrade`,
    // A running Project that cannot be upgraded where it stands is stopped and started again by the Platform.
    { method: "POST", body: JSON.stringify({ restart: true, ...(recipeName ? { recipeName } : {}) }) },
  );
  return normalizeRuntimeProject(result.project);
}

export async function restartProject(
  config: RuntimeConfig,
  projectId: string,
): Promise<RuntimeProject> {
  const result = await readJson<{ project: RuntimeProject }>(
    `${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/restart`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return normalizeRuntimeProject(result.project);
}

export async function deleteProject(
  config: RuntimeConfig,
  projectId: string,
): Promise<void> {
  await readJson<{ deleted: true }>(
    `${config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
}

export async function getDashboardSettings(
  config: RuntimeConfig,
): Promise<DashboardSettings> {
  return readJson<DashboardSettings>(
    `${config.api.basePath}/runtime/settings`,
  );
}

export const ASSISTANT_PROVIDERS = ["openrouter", "openai", "anthropic"] as const;
export type AssistantProviderName = (typeof ASSISTANT_PROVIDERS)[number];

export interface AssistantProviderStatus {
  mode: "model" | "local-router";
  provider?: AssistantProviderName;
  model?: string;
  /** Whether a key is stored here; the key itself is never returned. */
  hasApiKey: boolean;
  /** For a Project, `platform` means it inherits the installation's provider. */
  source: "environment" | "stored" | "project" | "platform" | "none";
  updatedAt?: string;
}

export interface AssistantAuditRecord {
  id: string;
  at: string;
  principalId: string;
  tool: string;
  arguments: string;
  decision: "allowed" | "denied" | "invalid" | "failed" | "pending_approval" | "executed";
  reason?: string;
}

/** Mirrors the runtime's update status; see `ZelavisUpdateStatus` in the `zelavis` package. */
export type UpdateState = "idle" | "requested" | "running" | "succeeded" | "failed" | "rolled-back";

export interface UpdateRun {
  id: string;
  state: Exclude<UpdateState, "idle" | "requested">;
  from: string;
  to?: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  log?: readonly string[];
}

export interface UpdateStatus {
  current: string;
  channel?: "alpha" | "latest";
  latest?: string;
  available: boolean;
  checkedAt?: string;
  checkError?: string;
  managed: boolean;
  unmanagedReason?: string;
  state: UpdateState;
  run?: UpdateRun;
  /** An update finished but the running process is still the old version. */
}

export async function getUpdateStatus(config: RuntimeConfig): Promise<UpdateStatus> {
  return readJson(`${config.api.basePath}/runtime/updates`);
}

export async function checkForUpdate(config: RuntimeConfig): Promise<UpdateStatus> {
  return readJson(`${config.api.basePath}/runtime/updates/check`, { method: "POST" });
}

export async function applyUpdate(config: RuntimeConfig): Promise<UpdateStatus> {
  return readJson(`${config.api.basePath}/runtime/updates/apply`, { method: "POST" });
}

export async function listAssistantAudit(
  config: RuntimeConfig,
  input: { before?: string; limit?: number } = {},
): Promise<{ records: AssistantAuditRecord[]; next?: string }> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 25) });
  if (input.before) query.set("before", input.before);
  return readJson(`${config.api.basePath}/runtime/assistant/audit?${query}`);
}

function assistantProviderPath(config: RuntimeConfig, projectId?: string) {
  return projectId
    ? `${config.api.basePath}/runtime/assistant/projects/${encodeURIComponent(projectId)}/provider`
    : `${config.api.basePath}/runtime/assistant/provider`;
}

/** The installation's provider, or one Project's when `projectId` is given. */
export async function getAssistantProvider(
  config: RuntimeConfig,
  projectId?: string,
): Promise<AssistantProviderStatus> {
  return readJson<AssistantProviderStatus>(assistantProviderPath(config, projectId));
}

export async function setAssistantProvider(
  config: RuntimeConfig,
  input: { provider: AssistantProviderName; model: string; apiKey: string },
  projectId?: string,
): Promise<AssistantProviderStatus> {
  return readJson<AssistantProviderStatus>(assistantProviderPath(config, projectId), {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function clearAssistantProvider(
  config: RuntimeConfig,
  projectId?: string,
): Promise<AssistantProviderStatus> {
  return readJson<AssistantProviderStatus>(assistantProviderPath(config, projectId), {
    method: "DELETE",
  });
}

export async function updateDashboardSettings(
  config: RuntimeConfig,
  input: DashboardSettingsUpdate,
): Promise<DashboardSettings> {
  return readJson<DashboardSettings>(
    `${config.api.basePath}/runtime/settings`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function listDashboardServices(
  config: RuntimeConfig,
): Promise<RuntimeServiceRegistryEntry[]> {
  const result = await readJson<{ services: RuntimeServiceRegistryEntry[] }>(
    `${config.api.basePath}/runtime/services`,
  );

  return result.services;
}

export interface MarketplaceAllowlistStatus {
  gated: boolean;
  /** How many places the list is fetched from; none means only the list shipped with the release. */
  sources: number;
  list?: {
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    origin: "remote" | "cache" | "bundled";
    fetchedAt?: string;
    status: "fresh" | "stale" | "expired";
    services: number;
  };
}

export interface MarketplaceRefreshReport extends MarketplaceAllowlistStatus {
  updated: boolean;
  attempts: readonly { source: string; outcome: string; detail?: string }[];
}

/** How current this installation's allow-list is; `undefined` when it may not see it or has none. */
export async function getMarketplaceAllowlist(
  config: RuntimeConfig,
): Promise<MarketplaceAllowlistStatus | undefined> {
  try {
    return await readJson<MarketplaceAllowlistStatus>(
      `${config.api.basePath}/runtime/marketplace/allowlist`,
    );
  } catch {
    return undefined;
  }
}

export async function refreshMarketplaceAllowlist(
  config: RuntimeConfig,
): Promise<MarketplaceRefreshReport> {
  return readJson<MarketplaceRefreshReport>(
    `${config.api.basePath}/runtime/marketplace/allowlist/refresh`,
    { method: "POST" },
  );
}

export async function updateDashboardService(
  config: RuntimeConfig,
  name: string,
  input: RuntimeServiceRegistryUpdate,
): Promise<RuntimeServiceRegistryMutationResult> {
  const result = await readJson<{
    services: RuntimeServiceRegistryEntry[];
    activation?: RuntimeServiceActivationResult;
  }>(
    `${config.api.basePath}/runtime/services/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );

  return {
    serviceRegistry: result.services,
    activation: result.activation,
  };
}

export async function createDashboardService(
  config: RuntimeConfig,
  input: RuntimeServiceRegistryCreate,
): Promise<RuntimeServiceRegistryMutationResult> {
  const body =
    input.file !== undefined
      ? (() => {
          const form = new FormData();

          form.set("file", input.file as Blob, input.file.name);
          if (input.specifier) {
            form.set("specifier", input.specifier);
          }
          if (input.name) {
            form.set("name", input.name);
          }
          if (input.status) {
            form.set("status", input.status);
          }
          if (input.source) {
            form.set("source", input.source);
          }
          if (input.order !== undefined) {
            form.set("order", String(input.order));
          }

          return form;
        })()
      : JSON.stringify(input);

  const result = await readJson<{
    services: RuntimeServiceRegistryEntry[];
    activation?: RuntimeServiceActivationResult;
  }>(
    `${config.api.basePath}/runtime/services`,
    {
      method: "POST",
      body,
    },
  );

  return {
    serviceRegistry: result.services,
    activation: result.activation,
  };
}


export async function listWorkloads(
  config: RuntimeConfig,
  options: {
    projectId?: string;
    type?: WorkloadType;
  } = {},
) {
  const search = new URLSearchParams();
  if (options.projectId) {
    search.set("projectId", options.projectId);
  }
  if (options.type) {
    search.set("type", options.type);
  }

  const query = search.size > 0 ? `?${search.toString()}` : "";
  const result = await readJson<{ workloads: WorkloadDefinition[] }>(
    `${config.api.basePath}/workloads${query}`,
  );

  return result.workloads;
}

export async function createWorkload(
  config: RuntimeConfig,
  input: WorkloadSaveInput,
) {
  return readJson<WorkloadDefinition>(`${config.api.basePath}/workloads`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getWorkload(config: RuntimeConfig, id: string) {
  return readJson<WorkloadDefinition>(
    `${config.api.basePath}/workloads/${encodeURIComponent(id)}`,
  );
}

export async function updateWorkload(
  config: RuntimeConfig,
  id: string,
  input: WorkloadSaveInput,
) {
  return readJson<WorkloadDefinition>(
    `${config.api.basePath}/workloads/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export async function runWorkload(config: RuntimeConfig, id: string) {
  return readJson<WorkloadRunLog>(
    `${config.api.basePath}/workloads/${encodeURIComponent(id)}/run`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function listWorkloadLogs(
  config: RuntimeConfig,
  options: {
    projectId?: string;
    workloadId?: string;
  } = {},
) {
  const search = new URLSearchParams();
  if (options.projectId) {
    search.set("projectId", options.projectId);
  }
  if (options.workloadId) {
    search.set("workloadId", options.workloadId);
  }

  const query = search.size > 0 ? `?${search.toString()}` : "";
  const result = await readJson<{ logs: WorkloadRunLog[] }>(
    `${config.api.basePath}/workloads/logs${query}`,
  );

  return result.logs;
}

export async function listStorageFiles(
  config: RuntimeConfig,
  prefix?: string,
): Promise<{
  files: StorageFile[];
  references: StorageFileReference[];
}> {
  const search = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
  return readJson<{
    files: StorageFile[];
    references: StorageFileReference[];
  }>(`${config.api.basePath}/storage/files${search}`);
}

export async function getStorageFileMetadata(
  config: RuntimeConfig,
  path: string,
): Promise<{
  file: StorageFile;
  reference: StorageFileReference;
}> {
  return readJson<{ file: StorageFile; reference: StorageFileReference }>(
    `${config.api.basePath}/storage/files/${encodeStoragePath(path)}?format=metadata`,
  );
}

export async function uploadStorageFile(
  config: RuntimeConfig,
  input: {
    path: string;
    body: Blob | ArrayBuffer | Uint8Array | string;
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    metadata?: Record<string, string>;
    onProgress?: (value: { loaded: number; total?: number; percent?: number }) => void;
  },
): Promise<{
  file: StorageFile;
  reference: StorageFileReference;
}> {
  const headers = new Headers();
  if (input.contentType) {
    headers.set("content-type", input.contentType);
  }
  if (input.cacheControl) {
    headers.set("cache-control", input.cacheControl);
  }
  if (input.contentDisposition) {
    headers.set("content-disposition", input.contentDisposition);
  }

  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    headers.set(`x-zelavis-meta-${key}`, value);
  }

  const body =
    input.body instanceof Uint8Array
      ? new Blob([
          input.body.buffer.slice(
            input.body.byteOffset,
            input.body.byteOffset + input.body.byteLength,
          ) as ArrayBuffer,
        ])
      : input.body;

  if (typeof window !== "undefined" && typeof XMLHttpRequest !== "undefined") {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open(
        'PUT',
        `${config.api.basePath}/storage/files/${encodeStoragePath(input.path)}`,
      )

      headers.forEach((value, key) => {
        request.setRequestHeader(key, value)
      })

      request.responseType = 'json'
      request.upload.onprogress = (event) => {
        if (!input.onProgress) {
          return
        }

        const total = event.lengthComputable ? event.total : undefined
        const percent =
          total && total > 0 ? Math.round((event.loaded / total) * 100) : undefined
        input.onProgress({
          loaded: event.loaded,
          total,
          percent,
        })
      }

      request.onload = () => {
        const ok = request.status >= 200 && request.status < 300
        const responseBody =
          typeof request.response === 'object' && request.response !== null
            ? request.response
            : request.responseText
              ? JSON.parse(request.responseText)
              : undefined

        if (!ok) {
          const message =
            responseBody &&
            typeof responseBody === 'object' &&
            'error' in responseBody &&
            typeof (responseBody as { error?: unknown }).error === 'string'
              ? (responseBody as { error: string }).error
              : `Request failed: ${request.status}`
          reject(new Error(`${message} (${input.path})`))
          return
        }

        resolve(responseBody as { file: StorageFile; reference: StorageFileReference })
      }

      request.onerror = () => {
        reject(new Error(`Request failed (${input.path})`))
      }

      request.send(body)
    })
  }

  const response = await fetch(
    `${config.api.basePath}/storage/files/${encodeStoragePath(input.path)}`,
    {
      method: "PUT",
      headers,
      body,
    },
  );

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    let message = `Request failed: ${response.status}`;
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    }
    throw new Error(`${message} (${input.path})`);
  }

  return response.json() as Promise<{
    file: StorageFile;
    reference: StorageFileReference;
  }>;
}

export async function deleteStorageFile(
  config: RuntimeConfig,
  path: string,
): Promise<{ deleted: boolean; path: string }> {
  return readJson<{ deleted: boolean; path: string }>(
    `${config.api.basePath}/storage/files/${encodeStoragePath(path)}`,
    {
      method: "DELETE",
    },
  );
}

export async function getFabricSnapshot(config: RuntimeConfig) {
  return readJson<FabricSnapshot>(`${config.api.basePath}/fabric/snapshot`);
}

export async function listDeploymentBackends(config: RuntimeConfig): Promise<{
  policy: RuntimeDeploymentBackendPolicy;
  backends: RuntimeDeploymentBackendSnapshot[];
}> {
  return readJson(`${config.api.basePath}/runtime/deployment-backends`);
}

export async function detectDeploymentBackends(
  config: RuntimeConfig,
  id?: string,
): Promise<{ backends: RuntimeDeploymentBackendSnapshot[] }> {
  return readJson(`${config.api.basePath}/runtime/deployment-backends/detect`, {
    method: "POST",
    body: JSON.stringify(id ? { id } : {}),
  });
}

export async function updateDeploymentBackendPolicy(
  config: RuntimeConfig,
  id: string,
  action: "enable" | "disable" | "default",
): Promise<{ policy: RuntimeDeploymentBackendPolicy }> {
  return readJson(
    `${config.api.basePath}/runtime/deployment-backends/${encodeURIComponent(id)}/${action}`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function getDatabaseHealth(config: RuntimeConfig) {
  return readJson<DatabaseHealth>(`${config.api.basePath}/database/health`);
}

export async function listAuthProviders(config: RuntimeConfig) {
  return readJson<string[]>(`${config.api.basePath}/auth/providers`);
}

export async function listAuthOAuthConnections(config: RuntimeConfig) {
  return (await readJson<{ providers: AuthOAuthConnection[] }>(
    `${config.api.basePath}/auth/oauth/connections`,
  )).providers;
}

export async function configureAuthOAuthConnection(
  config: RuntimeConfig,
  provider: string,
  input: {
    issuer?: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    enabled?: boolean;
  },
) {
  return (await readJson<{ connection: AuthOAuthConnection }>(
    `${config.api.basePath}/auth/oauth/connections/${encodeURIComponent(provider)}`,
    { method: "PUT", body: JSON.stringify(input) },
  )).connection;
}

export async function removeAuthOAuthConnection(
  config: RuntimeConfig,
  provider: string,
) {
  await readJson<void>(
    `${config.api.basePath}/auth/oauth/connections/${encodeURIComponent(provider)}`,
    { method: "DELETE" },
  );
}

export async function listAuthAccounts(config: RuntimeConfig) {
  return readJson<AuthAccount[]>(`${config.api.basePath}/auth/accounts`);
}

export async function listServiceAccounts(config: RuntimeConfig) {
  return (await readJson<{ serviceAccounts: AuthAccount[] }>(
    `${config.api.basePath}/auth/service-accounts`,
  )).serviceAccounts;
}

export async function createServiceAccount(
  config: RuntimeConfig,
  input: {
    name: string;
    permissions?: readonly string[];
    grants?: readonly RuntimePrincipalGrant[];
    expiresInDays?: number;
  },
) {
  return readJson<{
    serviceAccount: AuthAccount;
    token: string;
    session: { id: string; expiresAt: string };
  }>(`${config.api.basePath}/auth/service-accounts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeServiceAccount(
  config: RuntimeConfig,
  accountId: string,
) {
  await readJson<void>(
    `${config.api.basePath}/auth/service-accounts/${encodeURIComponent(accountId)}`,
    { method: "DELETE" },
  );
}

export async function listDatabaseCollections(
  config: RuntimeConfig,
  tenantId: string,
) {
  const cacheBuster = Date.now().toString(36);
  const result = await readJson<{ collections: DatabaseCollection[] }>(
    `${config.api.basePath}/database/documents/collections?tenantId=${encodeURIComponent(tenantId)}&refresh=${cacheBuster}`,
  );
  return result.collections.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export interface SystemStoreNamespace { namespace: string; recordCount: number }
export interface SystemStorePage {
  records: { namespace: string; key: string; value: unknown; updatedAt: string }[];
  next?: string;
}
export async function listSystemStoreNamespaces(config: RuntimeConfig) {
  return (await readJson<{ namespaces: SystemStoreNamespace[] }>(`${config.api.basePath}/runtime/system-store/namespaces`)).namespaces;
}
export function listSystemStoreRecords(config: RuntimeConfig, namespace: string, after?: string) {
  const query = new URLSearchParams({ limit: "50" });
  if (after !== undefined) query.set("after", after);
  return readJson<SystemStorePage>(`${config.api.basePath}/runtime/system-store/namespaces/${encodeURIComponent(namespace)}/records?${query}`);
}

export async function listDatabaseTableMenu(config: RuntimeConfig) {
  const result = await readJson<{ items: RuntimeServiceMenuDefinition[] }>(
    `${config.api.basePath}/database/menu/tables`,
  );
  return result.items;
}

export async function queryDatabaseSystemView(
  config: RuntimeConfig,
  view: DatabaseSystemViewName,
  tenantId: string,
) {
  const result = await readJson<{ rows: DatabaseSystemViewRow[] }>(
    `${config.api.basePath}/database/maintenance/system/views/${encodeURIComponent(view)}?tenantId=${encodeURIComponent(tenantId)}&limit=500`,
  );
  return result.rows;
}

export async function createDatabaseCollection(
  config: RuntimeConfig,
  input: {
    name: string;
    surface?: DatabaseCollectionSurface;
    metadata?: Record<string, unknown>;
    tenantId: string;
  },
) {
  const collection = await readJson<DatabaseCollection>(
    `${config.api.basePath}/database/documents/collections`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );

  return collection;
}

export async function listDatabaseSchemaCollections(
  config: RuntimeConfig,
  tenantId: string,
) {
  const result = await readJson<{
    collections: DatabaseSchemaCollectionSummary[];
  }>(
    `${config.api.basePath}/database/schemas/collections?tenantId=${encodeURIComponent(tenantId)}`,
  );

  return result.collections;
}

export async function listDatabaseSchemaVersions(
  config: RuntimeConfig,
  collection: string,
  tenantId: string,
) {
  const result = await readJson<{
    collection: string;
    schemas: DatabaseStoredCollectionSchema[];
  }>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(collection)}?tenantId=${encodeURIComponent(tenantId)}`,
  );

  return result.schemas;
}

export async function createDatabaseSchema(
  config: RuntimeConfig,
  input: {
    collection: string;
    version: number;
    activate?: boolean;
    fields: CollectionFieldEntry[];
    tenantId: string;
  },
) {
  return readJson<DatabaseStoredCollectionSchema>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(input.collection)}`,
    {
      method: "POST",
      body: JSON.stringify({
        tenantId: input.tenantId,
        version: input.version,
        activate: input.activate ?? false,
        fields: input.fields,
      }),
    },
  );
}

export async function activateDatabaseSchemaVersion(
  config: RuntimeConfig,
  input: {
    collection: string;
    version: number;
    tenantId: string;
  },
) {
  return readJson<DatabaseStoredCollectionSchema>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(input.collection)}/activate`,
    {
      method: "POST",
      body: JSON.stringify({ tenantId: input.tenantId, version: input.version }),
    },
  );
}

export async function listDatabaseTimeSeries(
  config: RuntimeConfig,
  tenantId: string,
) {
  const result = await readJson<{ series: DatabaseTimeSeriesSummary[] }>(
    `${config.api.basePath}/database/timeseries/series?tenantId=${encodeURIComponent(tenantId)}`,
  );

  return result.series;
}

export async function queryDatabaseTimeSeriesRange(
  config: RuntimeConfig,
  input: {
    series: string;
    start?: number | string;
    end?: number | string;
    limit?: number;
    order?: "asc" | "desc";
    tenantId: string;
  },
) {
  const result = await readJson<{ points: DatabaseTimeSeriesPoint[] }>(
    `${config.api.basePath}/database/timeseries/${encodeURIComponent(input.series)}/range`,
    {
      method: "POST",
      body: JSON.stringify({
        start: input.start,
        end: input.end,
        limit: input.limit,
        order: input.order,
        tenantId: input.tenantId,
      }),
    },
  );

  return result.points;
}

export async function queryDatabaseTimeSeriesAggregate(
  config: RuntimeConfig,
  input: {
    series: string;
    op: DatabaseTimeSeriesAggregateOperation;
    start?: number | string;
    end?: number | string;
    tenantId: string;
  },
) {
  const result = await readJson<{ value: number }>(
    `${config.api.basePath}/database/timeseries/${encodeURIComponent(input.series)}/aggregate`,
    {
      method: "POST",
      body: JSON.stringify({
        op: input.op,
        start: input.start,
        end: input.end,
        tenantId: input.tenantId,
      }),
    },
  );

  return result.value;
}

export async function queryDatabaseDocuments(
  config: RuntimeConfig,
  collection: string,
  tenantId: string,
) {
  const result = await readJson<{ documents: DatabaseDocument[] }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(collection)}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        limit: 25,
        tenantId,
      }),
    },
  );

  return result.documents;
}

export async function getDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    id: string;
    tenantId: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}?tenantId=${encodeURIComponent(input.tenantId)}`,
  );
}

export async function insertDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    data: Record<string, unknown>;
    id?: string;
    tenantId: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}`,
    {
      method: "POST",
      body: JSON.stringify({
        data: input.data,
        id: input.id || undefined,
        tenantId: input.tenantId,
      }),
    },
  );
}

export async function updateDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    id: string;
    data: Record<string, unknown>;
    mode?: "merge" | "replace";
    tenantId: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        data: input.data,
        mode: input.mode ?? "merge",
        tenantId: input.tenantId,
      }),
    },
  );
}

export async function deleteDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    id: string;
    tenantId: string;
  },
) {
  return readJson<{ deleted: boolean }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}?tenantId=${encodeURIComponent(input.tenantId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function seedDemoDatabase(config: RuntimeConfig) {
  const tenantId = ZELAVIS_APP_ADMIN_TENANT_ID;
  const collections = await listDatabaseCollections(config, tenantId);
  if (!collections.some((collection) => collection.name === "products")) {
    await createDatabaseCollection(config, {
      name: "products",
      tenantId,
      metadata: {
        seededBy: "zelavis-dashboard",
      },
    });
  }

  const timestamp = Date.now();
  await insertDatabaseDocument(config, {
    collection: "products",
    tenantId,
    id: `starter-product-${timestamp}`,
    data: {
      name: "Starter Product",
      slug: `starter-product-${timestamp}`,
      price: 4900,
      currency: "EUR",
      status: "draft",
    },
  });

  await insertDatabaseDocument(config, {
    collection: "products",
    tenantId,
    id: `service-plan-${timestamp}`,
    data: {
      name: "Service Plan",
      slug: `service-plan-${timestamp}`,
      price: 9900,
      currency: "EUR",
      status: "active",
    },
  });
}

export interface RuntimeNode {
  nodeId: string;
  agentId: string;
  url: string;
  enrolledAt: number;
  state: "active" | "revoked";
  version?: string;
  compatibility: "current" | "behind" | "unknown";
}

export interface RuntimeNodeEnrollment {
  nodeId: string;
  origin: "cloud" | "operator";
  createdAt: number;
  expiresAt: number;
  state: "unused" | "consumed";
}

export interface RuntimeEnrollmentToken {
  nodeId: string;
  token: string;
  expiresAt: number;
}

export interface RuntimeCloudConnection {
  provider: string;
  label: string;
  connectedAt: number;
  connectedBy: string;
  tokenHint: string;
}

export interface RuntimeCloudNode {
  id: string;
  provider: string;
  state: "provisioning" | "ready" | "releasing" | "failed";
  region?: string;
}

export async function listNodes(config: RuntimeConfig) {
  return readJson<{ nodes: RuntimeNode[]; enrollments: RuntimeNodeEnrollment[] }>(
    `${config.api.basePath}/runtime/nodes`,
  );
}

export async function getNodePlatform(config: RuntimeConfig) {
  const result = await readJson<{ endpoint: { url: string; fingerprint: string } | null }>(
    `${config.api.basePath}/runtime/nodes/platform`,
  );
  return result.endpoint;
}

export async function createNodeEnrollment(
  config: RuntimeConfig,
  input: { nodeId: string; ttlMinutes?: number },
) {
  return readJson<RuntimeEnrollmentToken>(`${config.api.basePath}/runtime/nodes/enrollments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function removeNode(config: RuntimeConfig, nodeId: string) {
  return readJson<{ removed: boolean }>(
    `${config.api.basePath}/runtime/nodes/${encodeURIComponent(nodeId)}`,
    { method: "DELETE" },
  );
}

export async function getCloudConnection(config: RuntimeConfig) {
  const result = await readJson<{ connection: RuntimeCloudConnection | null }>(
    `${config.api.basePath}/runtime/cloud`,
  );
  return result.connection;
}

export async function connectCloud(
  config: RuntimeConfig,
  input: { provider: string; token: string; label?: string },
) {
  return readJson<{ connection: RuntimeCloudConnection }>(
    `${config.api.basePath}/runtime/cloud/connection`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function disconnectCloud(config: RuntimeConfig) {
  return readJson<{ disconnected: boolean }>(`${config.api.basePath}/runtime/cloud/connection`, {
    method: "DELETE",
  });
}

export async function listCloudNodes(config: RuntimeConfig) {
  const result = await readJson<{ nodes: RuntimeCloudNode[] }>(
    `${config.api.basePath}/runtime/cloud/nodes`,
  );
  return result.nodes;
}

export async function requestCloudNode(
  config: RuntimeConfig,
  input: { requestId: string; region?: string },
) {
  return readJson<{ node: RuntimeCloudNode }>(`${config.api.basePath}/runtime/cloud/nodes`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function releaseCloudNode(config: RuntimeConfig, nodeId: string) {
  return readJson<{ released: boolean }>(
    `${config.api.basePath}/runtime/cloud/nodes/${encodeURIComponent(nodeId)}`,
    { method: "DELETE" },
  );
}

export interface RuntimeCloudScaling {
  settings: {
    consent: boolean;
    maxMachines: number;
    cooldownMinutes: number;
    updatedAt: number;
    updatedBy: string;
  };
  last?: { outcome: string; at: number };
}

export async function getCloudScaling(config: RuntimeConfig) {
  const result = await readJson<{ scaling: RuntimeCloudScaling }>(
    `${config.api.basePath}/runtime/cloud/scaling`,
  );
  return result.scaling;
}

export async function setCloudScaling(
  config: RuntimeConfig,
  input: { consent: boolean; maxMachines: number; cooldownMinutes: number },
) {
  return readJson<{ settings: RuntimeCloudScaling["settings"] }>(
    `${config.api.basePath}/runtime/cloud/scaling`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}
