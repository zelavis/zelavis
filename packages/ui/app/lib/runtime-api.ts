export interface RuntimeServiceMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
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
  };
  items?: readonly RuntimeServiceMenuDefinition[];
}

export interface RuntimeService {
  name: string;
  core: boolean;
  apiPath: string;
  menu?: RuntimeServiceMenuDefinition;
}

export interface RuntimeServicePageDefinition {
  id: string;
  title?: string;
  src: string;
}

export interface RuntimeServiceRegistryMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
  fixed?: boolean;
  fixedOrder?: number;
  fixedActionScope?: "local" | "inherit" | "replace" | "clear";
  sectionLabel?: string;
  disabled?: boolean;
  access?: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[];
  dynamicItems?: {
    path: string;
    emptyTitle?: string;
  };
  page?: RuntimeServicePageDefinition;
  items?: readonly RuntimeServiceRegistryMenuDefinition[];
}

export interface RuntimeServiceRegistryEntry {
  name: string;
  version?: string;
  specifier?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
  menu?: RuntimeServiceRegistryMenuDefinition;
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
  services: RuntimeService[];
  serviceRegistry: RuntimeServiceRegistryEntry[];
  serviceActivation?: RuntimeServiceActivation;
  access?: RuntimeDashboardAccess;
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
  theme: DashboardThemeMode;
  pageBuilderEnabled: boolean;
  preferences: DashboardPreferences;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    theme: boolean;
    pageBuilder: boolean;
  };
  restartRequired: boolean;
}

export interface DashboardSettingsUpdate {
  rootPath?: string;
  theme?: DashboardThemeMode;
  pageBuilderEnabled?: boolean;
  preferences?: DashboardPreferences;
}

export interface WebsitePage {
  path: string;
  title: string;
  kicker?: string;
  headline?: string;
  description?: string;
}

export interface CommerceCustomer {
  id: string;
  accountId?: string;
  email: string;
  firstName?: string;
  lastName?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceCoupon {
  code: string;
  description?: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  active: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceProduct {
  id: string;
  slug: string;
  title: string;
  description?: string;
  price: {
    amount: number;
    currency: string;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuthAccount {
  id: string;
  email?: string;
  username?: string;
  displayName?: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceOrder {
  id: string;
  customerId: string;
  items: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
  }>;
  couponCodes: string[];
  status: "draft" | "pending" | "paid" | "cancelled" | "fulfilled";
  totals: {
    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    grandTotal: number;
    currency: string;
  };
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommercePaymentAttempt {
  id: string;
  orderId: string;
  provider: string;
  amount: number;
  currency: string;
  status: "requires_action" | "authorized" | "captured" | "failed" | "refunded";
  reference?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceSubscription {
  id: string;
  customerId: string;
  provider: string;
  amount: number;
  currency: string;
  interval: "day" | "week" | "month" | "year";
  intervalCount: number;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired" | "failed";
  cancelAtPeriodEnd: boolean;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  reference?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CommerceProvider {
  name: string;
  parentService: string;
  childService: boolean;
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
  driver: string;
  capabilities: Record<string, boolean>;
  defaultTenantId: string;
}

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

export interface DatabaseSchemaCollectionSummary {
  collection: string;
  activeVersion: number | null;
  versions: number[];
}

export interface DatabaseSystemTableSummary {
  name:
    | "zv_collections"
    | "zv_events"
    | "zv_schemas"
    | "zv_time_series_checkpoints"
    | "zv_time_series_points";
  physicalName: string;
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
      "/access",
      "/access/permissions",
      "/access/users",
      "/assistant",
      "/marketplace",
      "/projects",
      "/resources",
      "/security",
      "/services",
      "/server",
      "/server/backups",
      "/server/domains",
      "/server/logs",
      "/settings",
      "/settings/appearance",
      "/projects/default",
      "/projects/default/agents",
      "/projects/default/auth",
      "/projects/default/commerce",
      "/projects/default/commerce/customers",
      "/projects/default/commerce/coupons",
      "/projects/default/commerce/orders",
      "/projects/default/commerce/products",
      "/projects/default/content",
      "/projects/default/content/new",
      "/projects/default/database",
      "/projects/default/database/new",
      "/projects/default/media",
      "/projects/default/marketplace",
      "/projects/default/settings",
      "/projects/default/storage",
      "/projects/default/users",
      "/projects/default/website",
      "/projects/default/workloads",
      "/projects/default/workloads/functions/fn_hello_world",
      "/projects/default/workloads/jobs/job_placeholder",
      "/projects/default/workloads/logs",
      "/projects/default/workloads/new",
      "/projects/default/workloads/schedules/schedule_placeholder",
      "/projects/default/workloads/settings",
      "/projects/default/workloads/webhooks/webhook_placeholder",
    ],
    assetRoot: "/assets",
  },
  services: [
    {
      name: "@zelavis/server",
      core: true,
      apiPath: "/api/v1/runtime",
      menu: {
        title: "Access",
        path: "/access",
        pageLabel: "Access",
        panelLabel: "Access",
        sectionLabel: "Projects",
        surface: "platform",
        access: {
          permissions: ["access.manage"],
          scope: { type: "system" },
        },
        items: [
          {
            title: "Overview",
            path: "/access",
            pageLabel: "Access",
          },
          {
            title: "Users",
            path: "/access/users",
            pageLabel: "Users",
          },
          {
            title: "Permissions",
            path: "/access/permissions",
            pageLabel: "Permissions",
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
        surface: "core",
        panelLabel: "Database",
        items: [
          {
            title: "System Tables",
            panelLabel: "System Tables",
            items: [
              { title: "zv_collections", path: "/database" },
              { title: "zv_events", path: "/database" },
              { title: "zv_schemas", path: "/database" },
              { title: "zv_time_series_checkpoints", path: "/database" },
              { title: "zv_time_series_points", path: "/database" },
            ],
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
      },
    },
    {
      name: "@zelavis/workloads",
      core: true,
      apiPath: "/api/v1/workloads",
      menu: {
        title: "Workloads",
        surface: "core",
        panelLabel: "Workloads",
        items: [
          {
            title: "Functions",
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
            },
          },
          {
            title: "Jobs",
            panelLabel: "Jobs",
            dynamicItems: {
              path: "/workloads/menu/jobs",
              emptyTitle: "No jobs yet",
            },
          },
          {
            title: "Schedules",
            panelLabel: "Schedules",
            dynamicItems: {
              path: "/workloads/menu/schedules",
              emptyTitle: "No schedules yet",
            },
          },
          {
            title: "Webhooks",
            panelLabel: "Webhooks",
            dynamicItems: {
              path: "/workloads/menu/webhooks",
              emptyTitle: "No webhooks yet",
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
  serviceRegistry: [
    {
      name: "@zelavis/ecommerce",
      version: "0.1.0",
      status: "available",
      source: "official",
      menu: {
        title: "Ecommerce",
        path: "/commerce",
        pageLabel: "Commerce",
        items: [
          {
            title: "Products",
            path: "/commerce/products",
          },
          {
            title: "Orders",
            path: "/commerce/orders",
          },
          {
            title: "More",
            items: [
              {
                title: "Customers",
                path: "/commerce/customers",
              },
              {
                title: "Coupons",
                path: "/commerce/coupons",
              },
            ],
          },
        ],
      },
    },
  ],
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
      menu: service.menu ?? fallback?.menu,
    };
  });
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
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error.length > 0) {
          message = body.error;
        }
      } else if (response.status === 404) {
        message =
          "Zelavis API route was not found. If you are using the UI dev server, start the Node.js example and restart the UI dev server.";
      }
    } catch {
      // Keep the status-only fallback when the response is not JSON.
    }

    throw new Error(`${message} (${path})`);
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
  options: { projectId?: string },
): Promise<RuntimeServiceMenuDefinition> {
  const [staticItems, dynamicItems] = await Promise.all([
    Promise.all(
      (menu.items ?? []).map((item) =>
        resolveDynamicMenuItems(config, item, options),
      ),
    ),
    menu.dynamicItems
      ? readJson<{ items?: RuntimeServiceMenuDefinition[] }>(
          `${joinApiPath(config.api.basePath, menu.dynamicItems.path)}${
            options.projectId
              ? `?projectId=${encodeURIComponent(options.projectId)}`
              : ""
          }`,
        )
          .then((result) => result.items ?? [])
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
                disabled: true,
              },
            ]
          : []),
    ],
  };
}

async function resolveRuntimeServiceDynamicMenu(
  config: RuntimeConfig,
  service: RuntimeService,
  options: { projectId?: string },
): Promise<RuntimeService> {
  if (!hasDynamicItems(service.menu)) {
    return service;
  }

  return {
    ...service,
    menu: service.menu
      ? await resolveDynamicMenuItems(config, service.menu, options)
      : service.menu,
  };
}

async function resolveRuntimeRegistryDynamicMenu(
  config: RuntimeConfig,
  service: RuntimeServiceRegistryEntry,
  options: { projectId?: string },
): Promise<RuntimeServiceRegistryEntry> {
  if (!hasDynamicItems(service.menu)) {
    return service;
  }

  return {
    ...service,
    menu: service.menu
      ? (await resolveDynamicMenuItems(
          config,
          service.menu,
          options,
        )) as RuntimeServiceRegistryMenuDefinition
      : service.menu,
  };
}

export async function resolveRuntimeDynamicMenus(
  config: RuntimeConfig,
  options: { projectId?: string } = {},
): Promise<RuntimeConfig> {
  const [services, serviceRegistry] = await Promise.all([
    Promise.all(
      config.services.map((service) =>
        resolveRuntimeServiceDynamicMenu(config, service, options),
      ),
    ),
    Promise.all(
      config.serviceRegistry.map((service) =>
        resolveRuntimeRegistryDynamicMenu(config, service, options),
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
    };
  }
}

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  _runtimeConfigCache ??= _fetchRuntimeConfig();
  return _runtimeConfigCache;
}

export async function getDashboardAccess(
  config: RuntimeConfig,
  mode?: string,
): Promise<RuntimeDashboardAccess> {
  const suffix = mode ? `?as=${encodeURIComponent(mode)}` : "";
  return readJson<RuntimeDashboardAccess>(
    `${config.api.basePath}/runtime/access${suffix}`,
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

export async function listWebsitePages(config: RuntimeConfig) {
  const result = await readJson<{ pages: WebsitePage[] }>(
    `${config.api.basePath}/website/pages`,
  );

  return result.pages;
}

export async function createWebsitePage(
  config: RuntimeConfig,
  input: {
    title: string;
    path: string;
    headline?: string;
    description?: string;
  },
) {
  return readJson<WebsitePage>(`${config.api.basePath}/website/pages`, {
    method: "POST",
    body: JSON.stringify(input),
  });
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

export async function getDatabaseHealth(config: RuntimeConfig) {
  return readJson<DatabaseHealth>(`${config.api.basePath}/database/health`);
}

export async function listAuthProviders(config: RuntimeConfig) {
  return readJson<string[]>(`${config.api.basePath}/auth/providers`);
}

export async function listAuthAccounts(config: RuntimeConfig) {
  return readJson<AuthAccount[]>(`${config.api.basePath}/auth/accounts`);
}

export async function listCommerceProducts(config: RuntimeConfig) {
  return readJson<CommerceProduct[]>(`${config.api.basePath}/commerce/products`);
}

export async function createCommerceProduct(
  config: RuntimeConfig,
  input: {
    title: string;
    slug?: string;
    description?: string;
    price: {
      amount: number;
      currency: string;
    };
  },
) {
  return readJson<CommerceProduct>(`${config.api.basePath}/commerce/products`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listCommerceCustomers(config: RuntimeConfig) {
  return readJson<CommerceCustomer[]>(`${config.api.basePath}/commerce/customers`);
}

export async function createCommerceCustomer(
  config: RuntimeConfig,
  input: {
    email: string;
    firstName?: string;
    lastName?: string;
    accountId?: string;
  },
) {
  return readJson<CommerceCustomer>(`${config.api.basePath}/commerce/customers`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listCommerceCoupons(config: RuntimeConfig) {
  return readJson<CommerceCoupon[]>(`${config.api.basePath}/commerce/coupons`);
}

export async function createCommerceCoupon(
  config: RuntimeConfig,
  input: {
    code: string;
    description?: string;
    discountType: "percentage" | "fixed";
    discountValue: number;
    active?: boolean;
  },
) {
  return readJson<CommerceCoupon>(`${config.api.basePath}/commerce/coupons`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listCommerceOrders(config: RuntimeConfig) {
  return readJson<CommerceOrder[]>(`${config.api.basePath}/commerce/orders`);
}

export async function createCommerceOrder(
  config: RuntimeConfig,
  input: {
    customerId: string;
    items: CommerceOrder["items"];
    couponCodes?: string[];
    totals: CommerceOrder["totals"];
  },
) {
  return readJson<CommerceOrder>(`${config.api.basePath}/commerce/orders`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listCommerceProviders(config: RuntimeConfig) {
  const result = await readJson<{ providers: CommerceProvider[] }>(
    `${config.api.basePath}/commerce/payments/providers`,
  );
  return result.providers;
}

export async function listCommercePaymentAttempts(config: RuntimeConfig) {
  return readJson<CommercePaymentAttempt[]>(
    `${config.api.basePath}/commerce/payments/attempts`,
  );
}

export async function listCommerceSubscriptions(config: RuntimeConfig) {
  return readJson<CommerceSubscription[]>(
    `${config.api.basePath}/commerce/subscriptions`,
  );
}

export async function listDatabaseCollections(config: RuntimeConfig) {
  const cacheBuster = Date.now().toString(36);
  const result = await readJson<{ collections: DatabaseCollection[] }>(
    `${config.api.basePath}/database/documents/collections?refresh=${cacheBuster}`,
  );

  const collectionsByKey = new Map(
    result.collections.map((collection) => [
      `${collection.tenantId}:${collection.name}`,
      collection,
    ]),
  );

  try {
    const systemResult = await readJson<{
      rows: Array<{
        tenant_id?: unknown;
        name?: unknown;
        created_at?: unknown;
        document_count?: unknown;
        surface?: unknown;
        metadata_json?: unknown;
      }>;
    }>(
      `${config.api.basePath}/database/sql/system/zv_collections?limit=500&refresh=${cacheBuster}`,
    );

    for (const row of systemResult.rows) {
      if (typeof row.name !== "string") {
        continue;
      }

      const tenantId =
        typeof row.tenant_id === "string" ? row.tenant_id : "default";
      const metadata =
        typeof row.metadata_json === "string" && row.metadata_json.length > 0
          ? (JSON.parse(row.metadata_json) as Record<string, unknown> | null)
          : undefined;
      const surface =
        row.surface === "content-studio" || row.surface === "database"
          ? row.surface
          : undefined;

      collectionsByKey.set(`${tenantId}:${row.name}`, {
        name: row.name,
        tenantId,
        createdAt:
          typeof row.created_at === "string"
            ? row.created_at
            : new Date().toISOString(),
        documentCount:
          typeof row.document_count === "number" ? row.document_count : 0,
        surface,
        metadata: metadata ?? undefined,
      });
    }
  } catch {
    // Drivers without SQL support can still use the document collection endpoint.
  }

  return [...collectionsByKey.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function createDatabaseCollection(
  config: RuntimeConfig,
  input: {
    name: string;
    surface?: DatabaseCollectionSurface;
    metadata?: Record<string, unknown>;
    tenantId?: string;
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
      }),
    },
  );

  return result.value;
}

export async function queryDatabaseDocuments(
  config: RuntimeConfig,
  collection: string,
) {
  const result = await readJson<{ documents: DatabaseDocument[] }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(collection)}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        limit: 25,
      }),
    },
  );

  return result.documents;
}

export async function listDatabaseSystemTables(config: RuntimeConfig) {
  const result = await readJson<{ tables: DatabaseSystemTableSummary[] }>(
    `${config.api.basePath}/database/sql/system/tables`,
  );

  return result.tables;
}

export async function queryDatabaseSystemTable(
  config: RuntimeConfig,
  table: DatabaseSystemTableSummary["name"],
  options?: { limit?: number },
) {
  const params = new URLSearchParams();
  if (typeof options?.limit === "number") {
    params.set("limit", String(options.limit));
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const result = await readJson<{
    table: DatabaseSystemTableSummary["name"];
    rows: Record<string, unknown>[];
  }>(`${config.api.basePath}/database/sql/system/${encodeURIComponent(table)}${suffix}`);

  return result.rows;
}

export async function getDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    id: string;
    tenantId?: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}${input.tenantId ? `?tenantId=${encodeURIComponent(input.tenantId)}` : ""}`,
  );
}

export async function insertDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    data: Record<string, unknown>;
    id?: string;
    tenantId?: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}`,
    {
      method: "POST",
      body: JSON.stringify({
        data: input.data,
        id: input.id || undefined,
        tenantId: input.tenantId || undefined,
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
    tenantId?: string;
  },
) {
  return readJson<DatabaseDocument>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        data: input.data,
        mode: input.mode ?? "merge",
        tenantId: input.tenantId || undefined,
      }),
    },
  );
}

export async function deleteDatabaseDocument(
  config: RuntimeConfig,
  input: {
    collection: string;
    id: string;
    tenantId?: string;
  },
) {
  return readJson<{ deleted: boolean }>(
    `${config.api.basePath}/database/documents/${encodeURIComponent(input.collection)}/${encodeURIComponent(input.id)}${input.tenantId ? `?tenantId=${encodeURIComponent(input.tenantId)}` : ""}`,
    {
      method: "DELETE",
    },
  );
}

export async function seedDemoDatabase(config: RuntimeConfig) {
  const collections = await listDatabaseCollections(config);
  if (!collections.some((collection) => collection.name === "products")) {
    await createDatabaseCollection(config, {
      name: "products",
      metadata: {
        seededBy: "zelavis-dashboard",
      },
    });
  }

  const timestamp = Date.now();
  await insertDatabaseDocument(config, {
    collection: "products",
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
