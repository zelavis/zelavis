import type { AuthApi } from "../app/auth/index.js";
import { stringifyJsonRequest } from "../core/runtime/json-request.js";
import type { ServiceSourceDiagnostic } from "../platform/service-registry-view.js";
import type {
  ZelavisProjectLogEntry,
  ZelavisProjectRecord,
} from "../project.js";
import type { ZelavisProjectIsolationIntent } from "../project-isolation.js";
import type {
  ZelavisHostOperationCatalogEntry,
  ZelavisHostOperationRecord,
  ZelavisHostOperationSubmitInput,
} from "../platform/host-operations.js";
import type {
  DatabaseRuntimeApi,
  JsonObject as DatabaseJsonObject,
} from "../db/index.js";
import {
  requireActivePluginContext,
  getActivePluginContext,
  type PluginExecutionContext,
  type ZelavisCommandDefinition,
  type PluginFrontendBehavior,
  type PluginSetupHandler,
} from "../core/service/context.js";
import type {
  ZelavisServerRoute,
  ZelavisAnyRuntimeServiceInput,
} from "../core/runtime/contracts.js";
import { createPluginClients, validateOperationName, type RegisteredPluginClients, type PluginOperation } from "./plugins.js";
export type { PluginClients, PluginApiRegistry, RegisteredPluginClients, PluginOperation, PluginOperationOptions } from "./plugins.js";
import { createAPI, pluginsProxy, type CreateApiOptions, type PluginApiTree, type RegisteredPluginApis } from "./create-api.js";
export { createAPI, type CreateApiOptions, type PluginApiTree, type RegisteredPluginApis };
export type { PluginAuthoringApiRegistry, ZelavisCreateApiFunction, ZelavisMenuApi } from "./create-api.js";
import { isSandboxedServicePage, createServicePageFetch } from "./service-page.js";

export type { AuthApi, DatabaseRuntimeApi, DatabaseJsonObject };
export {
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  authService,
} from "../app/auth/index.js";
// The database is reached through `zelavis/db`, not re-exported here: its
// store is a host resource that opens files, and an SDK bundle a browser can
// load must not carry one.
export type {
  CollectionField,
  CollectionFieldEntry,
  CollectionSchema,
  CollectionSchemaSummary,
} from "../db/schema/index.js";

export type ZelavisSdkSurfaceTarget = "fetch" | "browser" | "node";
export type ZelavisSdkRuntimeName = "node" | "bun" | "deno";
export type ZelavisSdkServiceName =
  | "zelavis/app/auth"
  | "zelavis/db"
  | "zelavis/app/workloads"
  | "zelavis/runtime"
  | "@zelavis/ui";

export interface ZelavisSdkSurfaceManifest {
  readonly target: ZelavisSdkSurfaceTarget;
  readonly includes: {
    readonly contracts: true;
    readonly fetchClient: true;
    readonly localDatabaseCore: true;
    readonly services: readonly ZelavisSdkServiceName[];
  };
  readonly excludes: {
    readonly ui: true;
    readonly runtimes: readonly ZelavisSdkRuntimeName[];
    readonly services: readonly ZelavisSdkServiceName[];
  };
}

export interface ZelavisClientOptions {
  baseUrl?: string | URL;
  rootPath?: string;
  apiPrefix?: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface ZelavisClientRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | object | null;
  headers?: HeadersInit;
}

export interface ZelavisRuntimeConfigResponse {
  pluginOperations?: readonly PluginOperation[];
  rootPath: string;
  api: {
    basePath: string;
    version: string;
  };
  runtime?: {
    engine?: string;
    availableEngines?: readonly string[];
  };
  [key: string]: unknown;
}

export interface ZelavisDashboardSettingsResponse {
  rootPath?: {
    current: string;
    desired: string;
    pending?: string | null;
    restartRequired: boolean;
  };
  runtimeEngine?: {
    current: string;
    desired: string;
    available: readonly string[];
  };
  [key: string]: unknown;
}

export interface ZelavisDashboardSettingsUpdate {
  rootPath?: string;
  theme?: "light" | "dark" | "auto";
  runtimeEngine?: "node" | "bun" | "deno";
  pageBuilderEnabled?: boolean;
  preferences?: Record<string, unknown>;
}

export interface ZelavisClient {
  readonly plugins: RegisteredPluginClients;
  readonly baseUrl: URL;
  readonly rootPath: string;
  pluginOperations(): Promise<readonly PluginOperation[]>;
  request(
    path: string,
    options?: ZelavisClientRequestOptions,
  ): Promise<Response>;
  json<T = unknown>(
    path: string,
    options?: ZelavisClientRequestOptions,
  ): Promise<T>;
  /** Platform Projects, over `/runtime/projects`. Same contract as `zelavis projects`. */
  readonly projects: ZelavisProjectsClient;
  /** Release-signed host operations, over `/runtime/host-operations`. Same contract as `zelavis host-operations`. */
  readonly hostOperations: ZelavisHostOperationsClient;
  readonly runtime: {
    serviceSources(): Promise<{ sources: readonly ServiceSourceDiagnostic[] }>;
    config(): Promise<ZelavisRuntimeConfigResponse>;
    settings(): Promise<ZelavisDashboardSettingsResponse>;
    updateSettings(
      update: ZelavisDashboardSettingsUpdate,
    ): Promise<ZelavisDashboardSettingsResponse>;
  };
}

export interface ZelavisProjectCreateInput {
  readonly name: string;
  readonly id?: string;
  readonly recipeName?: string;
  /** Defaults to true. */
  readonly start?: boolean;
}

export interface ZelavisProjectRecipeSummary {
  readonly name: string;
  readonly title: string;
  readonly summary?: string;
  readonly runtimeKinds: readonly string[];
  readonly isolation?: ZelavisProjectIsolationIntent;
  readonly [key: string]: unknown;
}

export interface ZelavisProjectListResponse {
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly projects: readonly ZelavisProjectRecord[];
}

/**
 * Project lifecycle operations.
 *
 * Every method is one HTTP route; refusals arrive as `ZelavisClientHttpError`
 * with the route's status and body, including `code` and `isolation` when a
 * recipe's required isolation is not met (409).
 */
export interface ZelavisProjectsClient {
  list(): Promise<ZelavisProjectListResponse>;
  get(projectId: string): Promise<ZelavisProjectRecord>;
  create(input: ZelavisProjectCreateInput): Promise<ZelavisProjectRecord>;
  start(projectId: string): Promise<ZelavisProjectRecord>;
  stop(projectId: string): Promise<ZelavisProjectRecord>;
  restart(projectId: string): Promise<ZelavisProjectRecord>;
  logs(projectId: string): Promise<readonly ZelavisProjectLogEntry[]>;
  remove(projectId: string): Promise<{ readonly deleted: boolean }>;
  recipes(): Promise<readonly ZelavisProjectRecipeSummary[]>;
}

export interface ZelavisHostOperationsClient {
  /** Operations the caller may request somewhere. */
  catalog(): Promise<readonly ZelavisHostOperationCatalogEntry[]>;
  /** Issues authority and hands the request to the Agent; resolves once accepted. */
  submit(input: ZelavisHostOperationSubmitInput): Promise<ZelavisHostOperationRecord>;
  get(operationId: string): Promise<ZelavisHostOperationRecord>;
  /** Issuance records, newest first; needs the audit permission for the scope. */
  audit(query?: { readonly projectId?: string; readonly limit?: number }): Promise<readonly ZelavisHostOperationRecord[]>;
}

export const fetchSdkSurface: ZelavisSdkSurfaceManifest = {
  target: "fetch",
  includes: {
    contracts: true,
    fetchClient: true,
    localDatabaseCore: true,
    services: ["zelavis/app/auth", "zelavis/db"],
  },
  excludes: {
    ui: true,
    runtimes: ["node", "bun", "deno"],
    services: ["zelavis/app/workloads", "zelavis/runtime", "@zelavis/ui"],
  },
};

export function createZelavisClient(
  options: ZelavisClientOptions = {},
): ZelavisClient {
  const sandboxed = isSandboxedServicePage();
  const resolvedFetch: typeof fetch =
    options.fetch ??
    (sandboxed
      ? createServicePageFetch()
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : (undefined as unknown as typeof fetch));

  if (typeof resolvedFetch !== "function") {
    throw new TypeError(
      "createZelavisClient requires a fetch implementation for this environment.",
    );
  }

  const defaultBaseUrl =
    typeof location !== "undefined" && location.origin && location.origin !== "null"
      ? location.origin
      : "http://localhost";
  const baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);
  const rootPath = normalizeRootPath(
    options.rootPath ?? (sandboxed ? "" : "/zelavis"),
  );
  const apiPrefix = normalizeRootPath(
    options.apiPrefix ?? (sandboxed ? "" : "/api"),
  );
  const apiVersion = options.apiVersion ?? (sandboxed ? "" : "v1");
  if (apiVersion && !/^[a-zA-Z0-9_-]+$/.test(apiVersion)) throw new TypeError("Invalid API version.");

  async function resolveHeaders(headers?: HeadersInit): Promise<Headers> {
    const resolved = new Headers(
      typeof options.headers === "function"
        ? await options.headers()
        : options.headers,
    );
    const next = new Headers(headers);
    next.forEach((value, key) => {
      resolved.set(key, value);
    });
    return resolved;
  }

  async function request(
    path: string,
    requestOptions: ZelavisClientRequestOptions = {},
  ): Promise<Response> {
    const { body, headers: requestHeaders, ...fetchOptions } = requestOptions;
    const headers = await resolveHeaders(requestHeaders);
    const init: RequestInit = {
      ...fetchOptions,
      headers,
    };

    if (body !== undefined && body !== null) {
      if (isBodyInit(body)) {
        init.body = body;
      } else {
        headers.set("content-type", "application/json");
        init.body = stringifyJsonRequest(body);
      }
    }

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const prefix = [rootPath, apiPrefix, apiVersion ? `/${apiVersion}` : ""]
      .join("")
      .replace(/\/+/g, "/");
    const fullPath = `${prefix}${normalizedPath}`.replace(/\/+/g, "/");
    return resolvedFetch(new URL(fullPath, baseUrl), init);
  }

  async function json<T = unknown>(
    path: string,
    requestOptions?: ZelavisClientRequestOptions,
  ): Promise<T> {
    const response = await request(path, requestOptions);
    if (!response.ok) {
      const body = await response.clone().json().catch(() => undefined);
      throw new ZelavisClientHttpError(response, body);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  // The last catalogue and its ETag. Every discovery still asks the server,
  // so revocation is immediate; an unchanged catalogue answers 304 and is not
  // transferred again.
  let catalogue: { etag: string; operations: readonly PluginOperation[] } | undefined;
  async function discoverPluginOperations(): Promise<readonly PluginOperation[]> {
    const response = await request("/runtime/plugin-operations", {
      headers: catalogue ? { "if-none-match": catalogue.etag } : {},
    });
    if (response.status === 304 && catalogue) return catalogue.operations;
    if (!response.ok) {
      const body = await response.clone().json().catch(() => undefined);
      throw new ZelavisClientHttpError(response, body);
    }
    const body = await response.json() as { operations?: readonly PluginOperation[] };
    const operations = body.operations ?? [];
    const etag = response.headers.get("etag");
    catalogue = etag ? { etag, operations } : undefined;
    return operations;
  }

  return {
    plugins: createPluginClients(
      discoverPluginOperations,
      async (path, method, body) => json(path, { method, body: body as object | undefined }),
    ),
    pluginOperations: discoverPluginOperations,
    projects: createProjectsClient(json),
    hostOperations: {
      catalog: async () =>
        (await json<{ operations: readonly ZelavisHostOperationCatalogEntry[] }>("/runtime/host-operations")).operations,
      submit: async (input) =>
        (await json<{ operation: ZelavisHostOperationRecord }>("/runtime/host-operations", {
          method: "POST",
          body: input,
        })).operation,
      audit: async (query = {}) => {
        const search = new URLSearchParams();
        if (query.projectId !== undefined) search.set("projectId", query.projectId);
        if (query.limit !== undefined) search.set("limit", String(query.limit));
        const suffix = search.size ? `?${search}` : "";
        return (await json<{ records: readonly ZelavisHostOperationRecord[] }>(
          `/runtime/host-operations/audit${suffix}`,
        )).records;
      },
      get: async (operationId) => {
        if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
          throw new TypeError("Invalid host operation id.");
        }
        return (await json<{ operation: ZelavisHostOperationRecord }>(
          `/runtime/host-operations/${operationId}`,
        )).operation;
      },
    },
    baseUrl,
    rootPath,
    request,
    json,
    runtime: {
      serviceSources() {
        return json<{ sources: readonly ServiceSourceDiagnostic[] }>("/runtime/services/sources");
      },
      config() {
        return json<ZelavisRuntimeConfigResponse>("/runtime/config");
      },
      settings() {
        return json<ZelavisDashboardSettingsResponse>("/runtime/settings");
      },
      updateSettings(update) {
        return json<ZelavisDashboardSettingsResponse>("/runtime/settings", {
          method: "PATCH",
          body: update,
        });
      },
    },
  };
}

function projectPath(projectId: string, action?: string): string {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TypeError("A Project id is required.");
  }
  const encoded = encodeURIComponent(projectId);
  if (encoded === "." || encoded === "..") throw new TypeError("Invalid Project id.");
  return `/runtime/projects/${encoded}${action ? `/${action}` : ""}`;
}

function createProjectsClient(
  json: <T>(path: string, options?: ZelavisClientRequestOptions) => Promise<T>,
): ZelavisProjectsClient {
  type ProjectBody = { project: ZelavisProjectRecord };
  const lifecycle = (action: "start" | "stop" | "restart") =>
    async (projectId: string) =>
      (await json<ProjectBody>(projectPath(projectId, action), { method: "POST" })).project;
  return {
    list: () => json<ZelavisProjectListResponse>("/runtime/projects"),
    get: async (projectId) => (await json<ProjectBody>(projectPath(projectId))).project,
    create: async (input) =>
      (await json<ProjectBody>("/runtime/projects", { method: "POST", body: input })).project,
    start: lifecycle("start"),
    stop: lifecycle("stop"),
    restart: lifecycle("restart"),
    logs: async (projectId) =>
      (await json<{ logs: readonly ZelavisProjectLogEntry[] }>(projectPath(projectId, "logs"))).logs,
    remove: (projectId) =>
      json<{ deleted: boolean }>(projectPath(projectId), { method: "DELETE" }),
    recipes: async () =>
      (await json<{ projectRecipes: readonly ZelavisProjectRecipeSummary[] }>(
        "/runtime/project-recipes",
      )).projectRecipes,
  };
}

export class ZelavisClientHttpError extends Error {
  readonly response: Response;
  readonly body: unknown;

  constructor(response: Response, body?: unknown) {
    super(body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : `Zelavis request failed with status ${response.status}.`);
    this.name = "ZelavisClientHttpError";
    this.response = response;
    this.body = body;
  }
}

export interface ZelavisRoutesApi {
  create(
    routes: ZelavisServerRoute | readonly ZelavisServerRoute[],
  ): readonly ZelavisServerRoute[];
}

export interface ZelavisCommandsApi {
  register(command: ZelavisCommandDefinition): ZelavisCommandDefinition;
}

export interface ZelavisEventsApi {
  on(
    event: string,
    handler: (...args: unknown[]) => void | Promise<void>,
  ): () => void;
}

export interface ZelavisPluginServicesApi {
  add(service: ZelavisAnyRuntimeServiceInput): void;
}

export type { PluginFrontendBehavior, PluginSetupHandler } from "../core/service/context.js";

export interface ZelavisSdk {
  readonly operations: {
    create(operation: ZelavisServerRoute & { resource: string; action: string }): void;
  };
  readonly plugins: RegisteredPluginApis;
  readonly routes: ZelavisRoutesApi;
  readonly commands: ZelavisCommandsApi;
  readonly events: ZelavisEventsApi;
  readonly services: ZelavisPluginServicesApi;
  readonly context: () => PluginExecutionContext | undefined;
  readonly createAPI: typeof createAPI;
  readonly frontend: { configure(behavior: PluginFrontendBehavior): void };
  readonly setup: (handler: PluginSetupHandler) => void;
  createClient(options: ZelavisClientOptions): ZelavisClient;
}

export const zelavis: ZelavisSdk = {
  operations: {
    create({ resource, action, ...route }) {
      const context = requireActivePluginContext("zelavis.operations.create");
      validateOperationName(resource);
      validateOperationName(action);
      if (!/^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*))*$/.test(route.path)) {
        throw new TypeError("Plugin operations require a resource path beginning with / without wildcards, queries or traversal.");
      }
      if (!route.spec) throw new TypeError("Plugin operations require a documented route spec.");
      if (context.routes.some((item) => item.meta?.pluginResource === resource && item.meta?.pluginAction === action)) {
        throw new TypeError(`Duplicate plugin operation: ${resource}.${action}`);
      }
      context.routes.push({ ...route, meta: { ...route.meta, pluginResource: resource, pluginAction: action } });
    },
  },
  plugins: pluginsProxy,
  routes: {
    create(routes) {
      const context = requireActivePluginContext("zelavis.routes.create");
      const list = Array.isArray(routes) ? routes : [routes];
      context.routes.push(...list);
      return list;
    },
  },
  commands: {
    register(command) {
      const context = requireActivePluginContext("zelavis.commands.register");
      context.commands.set(command.name, command);
      return command;
    },
  },
  events: {
    on(event, handler) {
      const context = requireActivePluginContext("zelavis.events.on");
      const entry = { event, handler };
      context.events.push(entry);
      return () => {
        const index = context.events.indexOf(entry);
        if (index >= 0) context.events.splice(index, 1);
      };
    },
  },
  services: {
    add(service) {
      const context = requireActivePluginContext("zelavis.services.add");
      context.services.push(service);
    },
  },
  context: () => getActivePluginContext(),
  createAPI,
  setup(handler) {
    const context = requireActivePluginContext("zelavis.setup");
    if (context.setup) throw new TypeError("Plugin setup is already registered.");
    if (typeof handler !== "function") throw new TypeError("Plugin setup requires a function.");
    context.setup = handler;
  },
  frontend: {
    configure(behavior) {
      const context = requireActivePluginContext("zelavis.frontend.configure");
      if (context.kind !== "frontend" || (context.manifest.zelavis?.frontend as { runtime?: string } | undefined)?.runtime !== "static") {
        throw new TypeError("Frontend behavior requires a static frontend manifest.");
      }
      if (context.frontend) throw new TypeError("Frontend behavior is already registered.");
      for (const key of Object.keys(behavior)) {
        if (!["shell", "devUrl", "devUrlExcludePaths"].includes(key)) {
          throw new TypeError(`Frontend metadata belongs in package.json: ${key}`);
        }
      }
      if (behavior.shell && typeof behavior.shell.render !== "function") {
        throw new TypeError("A frontend shell requires a render function.");
      }
      context.frontend = Object.freeze({ ...behavior });
    },
  },
  createClient: createZelavisClient,
};

export default zelavis;

function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === "string" ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob) ||
    (typeof FormData !== "undefined" && value instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" &&
      value instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && value instanceof ReadableStream)
  );
}
