import type { AuthApi } from "../app/auth/index.js";
import type {
  CreateDatabaseOptions,
  DatabaseApi,
  DatabaseJsonObject,
} from "../app/db/index.js";

export type {
  AuthApi,
  CreateDatabaseOptions,
  DatabaseApi,
  DatabaseJsonObject,
};
export {
  AuthDomainError,
  AuthNotFoundError,
  AuthValidationError,
  authService,
} from "../app/auth/index.js";
export {
  createDatabase,
  DatabaseConflictError,
  DatabaseNotFoundError,
  DatabaseRevisionMismatchError,
  DatabaseValidationError,
  defineDatabaseService,
} from "../app/db/index.js";
export type {
  CollectionField,
  CollectionFieldEntry,
  CollectionSchema,
  CollectionSchemaSummary,
} from "../app/db/schema/index.js";

export type ZelavisSdkSurfaceTarget = "fetch" | "browser" | "node";
export type ZelavisSdkRuntimeName = "node" | "bun" | "deno";
export type ZelavisSdkServiceName =
  | "zelavis/app/auth"
  | "zelavis/app/db"
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
  baseUrl: string | URL;
  rootPath?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}

export interface ZelavisClientRequestOptions extends Omit<RequestInit, "body"> {
  body?: BodyInit | object | null;
  headers?: HeadersInit;
}

export interface ZelavisRuntimeConfigResponse {
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
    restartRequired: boolean;
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
  readonly baseUrl: URL;
  readonly rootPath: string;
  request(path: string, options?: ZelavisClientRequestOptions): Promise<Response>;
  json<T = unknown>(
    path: string,
    options?: ZelavisClientRequestOptions,
  ): Promise<T>;
  runtime: {
    config(): Promise<ZelavisRuntimeConfigResponse>;
    settings(): Promise<ZelavisDashboardSettingsResponse>;
    updateSettings(
      update: ZelavisDashboardSettingsUpdate,
    ): Promise<ZelavisDashboardSettingsResponse>;
  };
}

export const fetchSdkSurface: ZelavisSdkSurfaceManifest = {
  target: "fetch",
  includes: {
    contracts: true,
    fetchClient: true,
    localDatabaseCore: true,
    services: ["zelavis/app/auth", "zelavis/app/db"],
  },
  excludes: {
    ui: true,
    runtimes: ["node", "bun", "deno"],
    services: ["zelavis/app/workloads", "zelavis/runtime", "@zelavis/ui"],
  },
};

export function createZelavisClient(
  options: ZelavisClientOptions,
): ZelavisClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError(
      "createZelavisClient requires a fetch implementation for this environment.",
    );
  }

  const baseUrl = new URL(options.baseUrl);
  const rootPath = normalizeRootPath(options.rootPath ?? "/zelavis");

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
        init.body = JSON.stringify(body);
      }
    }

    return fetchImplementation(resolveApiUrl(baseUrl, rootPath, path), init);
  }

  async function json<T = unknown>(
    path: string,
    requestOptions?: ZelavisClientRequestOptions,
  ): Promise<T> {
    const response = await request(path, requestOptions);
    if (!response.ok) {
      throw new ZelavisClientHttpError(response);
    }

    return response.json() as Promise<T>;
  }

  return {
    baseUrl,
    rootPath,
    request,
    json,
    runtime: {
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

export class ZelavisClientHttpError extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super(`Zelavis request failed with status ${response.status}.`);
    this.name = "ZelavisClientHttpError";
    this.response = response;
  }
}

function normalizeRootPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function resolveApiUrl(baseUrl: URL, rootPath: string, path: string): URL {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${rootPath}/api/v1${normalizedPath}`, baseUrl);
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
