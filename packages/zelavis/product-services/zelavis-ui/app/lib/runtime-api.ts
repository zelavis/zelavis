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
  core: boolean;
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
  specifier?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
  marketplace?: {
    title?: string;
    summary?: string;
    description?: string;
    categories?: readonly string[];
    tags?: readonly string[];
  };
  project?: {
    runtimeKinds: readonly RuntimeProjectRuntimeKind[];
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
    resourceLimits: RuntimeDeploymentBackendFeatureState;
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
  id: string;
  name: string;
  kind: string;
  runtimeKind: RuntimeProjectRuntimeKind;
  app: {
    name: string;
    title: string;
    version?: string;
    specifier: string;
    runtimeKinds: readonly RuntimeProjectRuntimeKind[];
  };
  capabilities: RuntimeProjectDriverCapabilities;
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

function appTitleFromName(name: string): string {
  if (name === "zelavis/app") {
    return "Zelavis App";
  }

  return name
    .replace(/^@/, "")
    .replace(/^zelavis\//, "")
    .replace(/[-_/]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function normalizeRuntimeProject(project: RuntimeProject): RuntimeProject {
  const storedApp = project.app as RuntimeProject["app"] | undefined;
  const appName =
    typeof storedApp?.name === "string" && storedApp.name.length > 0
      ? storedApp.name
      : project.kind === "zelavis"
        ? "zelavis/app"
        : project.kind || "app";
  const appTitle =
    typeof storedApp?.title === "string" && storedApp.title.length > 0
      ? storedApp.title
      : appTitleFromName(appName);

  return {
    ...project,
    runtimeKind: project.runtimeKind ?? "native",
    app: {
      name: appName,
      title: appTitle,
      ...(storedApp?.version ? { version: storedApp.version } : {}),
      specifier: storedApp?.specifier ?? appName,
      runtimeKinds: storedApp?.runtimeKinds ?? ["native"],
    },
  };
}

export interface RuntimeAppService {
  name: string;
  title: string;
  version?: string;
  specifier?: string;
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
  createdAt: string;
}

export interface RuntimeAssistantThread {
  id: string;
  title: string;
  projectId?: string;
  messages: readonly RuntimeAssistantMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeServiceRegistryMutationResult {
  serviceRegistry: RuntimeServiceRegistryEntry[];
  activation?: RuntimeServiceActivationResult;
}

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

export const DATABASE_COLLECTION_CREATED_EVENT =
  "zelavis:database-collection-created";

function dispatchDatabaseCollectionCreated(collection: DatabaseCollection) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DatabaseCollection>(DATABASE_COLLECTION_CREATED_EVENT, {
      detail: collection,
    }),
  );
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
  metadata?: Record<string, unknown>;
  createdAt: string;
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
  capabilities: Record<string, boolean>;
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
  services: [
    {
      name: "zelavis/platform",
      core: true,
      apiPath: "/api/v1/runtime",
      menu: {
        title: "Server",
        path: "/server",
        pageLabel: "Server",
        sectionLabel: "Manage",
        order: 60,
        surface: "platform",
        access: {
          permissions: ["server.manage"],
          scope: { type: "system" },
        },
        items: [
          {
            title: "Overview",
            path: "/server",
            pageLabel: "Server",
          },
          {
            title: "Deployment backends",
            path: "/server/runtimes",
            pageLabel: "Deployment backends",
            access: {
              permissions: ["server.backends.view"],
              scope: { type: "system" },
            },
          },
          {
            title: "Domains",
            path: "/server/domains",
            pageLabel: "Domains",
            panelLabel: "Domains",
            access: {
              permissions: ["server.domains.view"],
              scope: { type: "system" },
            },
            items: [
              {
                title: "Overview",
                path: "/server/domains",
                pageLabel: "Domains",
              },
              {
                title: "Add Domain",
                path: "/server/domains",
                search: { domainAction: "add" },
                pageLabel: "Add Domain",
              },
              {
                title: "Buy",
                path: "/server/domains",
                search: { domainAction: "buy" },
                pageLabel: "Buy Domain",
              },
              {
                title: "Transfer",
                path: "/server/domains",
                search: { domainAction: "transfer" },
                pageLabel: "Transfer Domain",
              },
            ],
          },
          {
            title: "Access",
            path: "/server/access",
            pageLabel: "Access",
            panelLabel: "Access",
            access: {
              permissions: ["access.manage"],
              scope: { type: "system" },
            },
            items: [
              {
                title: "Overview",
                path: "/server/access",
                pageLabel: "Access",
              },
              {
                title: "Users",
                path: "/server/access/users",
                pageLabel: "Users",
              },
              {
                title: "Permissions",
                path: "/server/access/permissions",
                pageLabel: "Permissions",
              },
            ],
          },
          {
            title: "Backups",
            path: "/server/backups",
            pageLabel: "Backups",
          },
          {
            title: "Logs",
            path: "/server/logs",
            pageLabel: "Logs",
          },
        ],
      },
    },
    {
      name: "@zelavis/ui",
      core: true,
      apiPath: "/",
      menu: {
        title: "Dashboard",
        path: "/",
        surface: "root",
      },
    },
    {
      name: "@zelavis/auth",
      core: true,
      apiPath: "/api/v1/auth",
      menu: {
        title: "Auth",
        path: "/auth",
        surface: "core",
      },
    },
    {
      name: "@zelavis/db",
      core: true,
      apiPath: "/api/v1/database",
      menu: {
        title: "Database",
        path: "/database",
        surface: "core",
        panelLabel: "Database",
        dynamicItems: {
          path: "/database/menu/tables?tenantId=zelavis-app",
          emptyTitle: "No tables yet",
        },
        items: [
          {
            title: "Create Table",
            path: "/database/new",
            pageLabel: "Database",
            fixed: true,
            fixedOrder: 1,
          },
        ],
      },
    },
    {
      name: "@zelavis/storage",
      core: true,
      apiPath: "/api/v1/storage",
      menu: {
        title: "Storage",
        path: "/storage",
        surface: "core",
      },
    },
    {
      name: "@zelavis/website",
      core: true,
      apiPath: "/",
      menu: {
        title: "Website",
        path: "/website",
        pageLabel: "Website",
        sectionLabel: "Build",
        surface: "root",
        access: {
          permissions: ["project.website.manage"],
          scope: { type: "project", projectIdParam: "projectId" },
        },
      },
    },
    {
      name: "@zelavis/workloads",
      core: true,
      apiPath: "/api/v1/workloads",
      menu: {
        title: "Workloads",
        path: "/workloads",
        surface: "core",
        panelLabel: "Workloads",
        items: [
          {
            title: "Functions",
            path: "/workloads/functions",
            panelLabel: "Functions",
            items: [
              {
                title: "Add Function",
                path: "/workloads/new",
                pageLabel: "Workloads",
                fixed: true,
                fixedOrder: 1,
              },
            ],
            dynamicItems: {
              path: "/workloads/menu/functions",
              emptyTitle: "No functions yet",
              emptyPath: "/workloads/functions",
            },
          },
          {
            title: "Jobs",
            path: "/workloads/jobs",
            panelLabel: "Jobs",
            dynamicItems: {
              path: "/workloads/menu/jobs",
              emptyTitle: "No jobs yet",
              emptyPath: "/workloads/jobs",
            },
          },
          {
            title: "Schedules",
            path: "/workloads/schedules",
            panelLabel: "Schedules",
            dynamicItems: {
              path: "/workloads/menu/schedules",
              emptyTitle: "No schedules yet",
              emptyPath: "/workloads/schedules",
            },
          },
          {
            title: "Webhooks",
            path: "/workloads/webhooks",
            panelLabel: "Webhooks",
            dynamicItems: {
              path: "/workloads/menu/webhooks",
              emptyTitle: "No webhooks yet",
              emptyPath: "/workloads/webhooks",
            },
          },
          { title: "Logs", path: "/workloads/logs", pageLabel: "Workloads" },
          {
            title: "Settings",
            path: "/workloads/settings",
            pageLabel: "Workloads",
          },
        ],
      },
    },
  ],
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
      // Keep the status-only fallback when the response is not JSON.
    }

    throw new RuntimeApiError(`${message} (${path})`, response.status, path);
  }

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
 * `commitNavigationRuntime(config)` to resolve the deferred.
 *
 * Because React Router calls matched `clientLoader` functions synchronously
 * in route-match order (root first), the deferred is always created before
 * child loaders execute their synchronous body.
 */
let _navigationDeferred: {
  projectId: string;
  promise: Promise<RuntimeConfig>;
  resolve: (config: RuntimeConfig) => void;
  reject: (error: unknown) => void;
} | undefined;

/**
 * Create the deferred promise for the current navigation.
 * Must be called **synchronously** (before any `await`) in the root loader.
 */
export function beginNavigationRuntimeResolve(
  projectId: string | undefined,
): void {
  if (!projectId) {
    _navigationDeferred = undefined;
    return;
  }
  let resolve!: (config: RuntimeConfig) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<RuntimeConfig>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  void promise.catch(() => undefined);
  _navigationDeferred = { projectId, promise, resolve, reject };
}

/**
 * Resolve the navigation deferred with the final runtime config.
 * Called by the root loader after it determines the correct config.
 */
export function commitNavigationRuntime(config: RuntimeConfig): void {
  _navigationDeferred?.resolve(config);
}

export function rejectNavigationRuntime(error: unknown): void {
  _navigationDeferred?.reject(error);
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
): Promise<RuntimeConfig> {
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
  return getProjectRuntimeConfig(controlConfig, projectId);
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

export async function listAppServices(
  config: RuntimeConfig,
): Promise<RuntimeAppService[]> {
  const result = await readJson<{ appServices: RuntimeAppService[] }>(
    `${config.api.basePath}/runtime/app-services`,
  );
  return result.appServices;
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
  const result = await readJson<{ thread: RuntimeAssistantThread }>(
    `${config.api.basePath}/runtime/assistant/threads/${encodeURIComponent(threadId)}`,
  );
  return result.thread;
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

export async function getProjectRuntimeConfig(
  controlConfig: RuntimeConfig,
  projectId: string,
): Promise<RuntimeConfig> {
  const proxyRoot = `${controlConfig.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
  const projectConfig = await readJson<RuntimeConfig>(
    `${proxyRoot}/zelavis/api/v1/runtime/config`,
  );
  const projectApiBasePath = `${proxyRoot}${projectConfig.api.basePath}`;

  return {
    ...projectConfig,
    rootPath: controlConfig.rootPath,
    configSource: "endpoint",
    api: {
      ...projectConfig.api,
      basePath: projectApiBasePath,
    },
    dashboard: controlConfig.dashboard,
    services: normalizeRuntimeServices(
      (projectConfig.services ?? [])
        .filter(
          (service) =>
            service.name !== "@zelavis/ui" &&
            service.name !== "@zelavis/ui:app",
        )
        .map((service) => ({
          ...service,
          apiPath: service.apiPath.startsWith(projectConfig.rootPath)
            ? `${proxyRoot}${service.apiPath}`
            : service.apiPath,
        })),
    ),
    serviceRegistry: normalizeRuntimeServiceRegistry(
      projectConfig.serviceRegistry ?? [],
    ),
  };
}

export async function createProject(
  config: RuntimeConfig,
  input: {
    name: string;
    id?: string;
    appServiceName?: string;
    start?: boolean;
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

export async function listAuthAccounts(config: RuntimeConfig) {
  return readJson<AuthAccount[]>(`${config.api.basePath}/auth/accounts`);
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

  dispatchDatabaseCollectionCreated(collection);

  return collection;
}

export async function listDatabaseSchemaCollections(config: RuntimeConfig) {
  const result = await readJson<{
    collections: DatabaseSchemaCollectionSummary[];
  }>(`${config.api.basePath}/database/schemas/collections`);

  return result.collections;
}

export async function listDatabaseSchemaVersions(
  config: RuntimeConfig,
  collection: string,
) {
  const result = await readJson<{
    collection: string;
    schemas: DatabaseStoredCollectionSchema[];
  }>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(collection)}`,
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
  },
) {
  return readJson<DatabaseStoredCollectionSchema>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(input.collection)}`,
    {
      method: "POST",
      body: JSON.stringify({
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
  },
) {
  return readJson<DatabaseStoredCollectionSchema>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(input.collection)}/activate`,
    {
      method: "POST",
      body: JSON.stringify({ version: input.version }),
    },
  );
}

export async function listDatabaseTimeSeries(config: RuntimeConfig) {
  const result = await readJson<{ series: DatabaseTimeSeriesSummary[] }>(
    `${config.api.basePath}/database/timeseries/series`,
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
