export interface RuntimeService {
  name: string;
  core: boolean;
  apiPath: string;
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
}

export type DashboardThemeMode = "light" | "dark" | "auto";

export interface DashboardSettings {
  rootPath: string;
  pendingRootPath?: string;
  apiBasePath: string;
  theme: DashboardThemeMode;
  persistence: "runtime" | "read-only";
  editable: {
    rootPath: boolean;
    theme: boolean;
  };
  restartRequired: boolean;
}

export interface DashboardSettingsUpdate {
  rootPath?: string;
  theme?: DashboardThemeMode;
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
      "/commerce",
      "/content",
      "/database",
      "/services",
      "/settings",
    ],
    assetRoot: "/assets",
  },
  services: [
    { name: "dashboard", core: true, apiPath: "/" },
    { name: "auth", core: true, apiPath: "/api/v1/auth" },
    { name: "database", core: true, apiPath: "/api/v1/database" },
  ],
};

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

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");

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
      configSource: "embedded",
    };
  }

  const rootPath = inferRootPath();
  const fallbackRootPath = inferFallbackRootPath(rootPath);

  try {
    const config = await readJson<RuntimeConfig>(
      `${rootPath}/api/v1/dashboard/config`,
    );
    return {
      ...config,
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
      services: fallbackConfig.services.map((service) => ({
        ...service,
        apiPath:
          service.name === "dashboard"
            ? fallbackRootPath || "/"
            : `${fallbackRootPath}/api/v1/${service.name}`,
      })),
    };
  }
}

export async function getDashboardSettings(
  config: RuntimeConfig,
): Promise<DashboardSettings> {
  return readJson<DashboardSettings>(
    `${config.api.basePath}/dashboard/settings`,
  );
}

export async function updateDashboardSettings(
  config: RuntimeConfig,
  input: DashboardSettingsUpdate,
): Promise<DashboardSettings> {
  return readJson<DashboardSettings>(
    `${config.api.basePath}/dashboard/settings`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function getDatabaseHealth(config: RuntimeConfig) {
  return readJson<DatabaseHealth>(`${config.api.basePath}/database/health`);
}

export async function listAuthProviders(config: RuntimeConfig) {
  return readJson<string[]>(`${config.api.basePath}/auth/providers`);
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
