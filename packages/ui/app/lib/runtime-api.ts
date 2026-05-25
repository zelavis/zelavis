export interface RuntimeServiceMenuDefinition {
  title: string;
  path?: string;
  pageLabel?: string;
  panelLabel?: string;
  surface?: "root" | "core" | "workspace" | "settings";
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
  strategy: "runtime-graph" | "worker-boundary" | "function-boundary" | "custom";
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

export interface DatabaseCollection {
  name: string;
  tenantId: string;
  createdAt: string;
  documentCount: number;
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
    | "_collections"
    | "_documents"
    | "_events"
    | "_schemas"
    | "_time_series_checkpoints"
    | "_time_series_points";
  physicalName: string;
}

export interface DatabaseStoredCollectionSchema {
  collection: string;
  version: number;
  document: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
      "/agents",
      "/auth",
      "/builder",
      "/builder/pages",
      "/commerce",
      "/commerce/customers",
      "/commerce/coupons",
      "/commerce/orders",
      "/commerce/products",
      "/content",
      "/content/new",
      "/database",
      "/media",
      "/marketplace",
      "/services",
      "/settings",
      "/settings/appearance",
      "/storage",
      "/users",
    ],
    assetRoot: "/assets",
  },
  services: [
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
        panelLabel: "Tables",
        items: [
          {
            title: "System Tables",
            panelLabel: "System Tables",
            items: [
              { title: "_collections", path: "/database" },
              { title: "_documents", path: "/database" },
              { title: "_events", path: "/database" },
              { title: "_schemas", path: "/database" },
              { title: "_time_series_checkpoints", path: "/database" },
              { title: "_time_series_points", path: "/database" },
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
        path: "/builder/pages",
        pageLabel: "Builder",
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

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
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
  const result = await readJson<{ collections: DatabaseCollection[] }>(
    `${config.api.basePath}/database/documents/collections`,
  );

  return result.collections;
}

export async function createDatabaseCollection(
  config: RuntimeConfig,
  input: {
    name: string;
    metadata?: Record<string, unknown>;
    tenantId?: string;
  },
) {
  return readJson<DatabaseCollection>(
    `${config.api.basePath}/database/documents/collections`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
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
    document: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
) {
  return readJson<DatabaseStoredCollectionSchema>(
    `${config.api.basePath}/database/schemas/${encodeURIComponent(input.collection)}`,
    {
      method: "POST",
      body: JSON.stringify({
        version: input.version,
        activate: input.activate ?? false,
        document: input.document,
        metadata: input.metadata,
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
