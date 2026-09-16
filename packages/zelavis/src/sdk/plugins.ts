import type { ZelavisServerRoute } from "../core/runtime/contracts.js";
import { validatePluginNamespace } from "../core/service/manifest.js";

/** A plugin's operation identity, shared by SDK discovery, HTTP and CLI. */
export interface PluginOperation {
  namespace: string;
  resource: string;
  action: string;
  method: ZelavisServerRoute["method"];
  path: string;
  spec?: ZelavisServerRoute["spec"];
}

export interface PluginOperationOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
}

export type PluginOperationClient = (
  input?: unknown,
  options?: PluginOperationOptions,
) => Promise<unknown>;

/** Plugins can export a typed view of this discovered API. */
export type PluginClients = Readonly<Record<string,
  Readonly<Record<string, Readonly<Record<string, PluginOperationClient>>>>>>;

/** A plugin package can publish this shape as its typed client contract. */
export interface PluginApiRegistry {}

export type RegisteredPluginClients = PluginClients & PluginApiRegistry;

export function validateOperationName(value: string): string {
  return validatePluginNamespace(value);
}

export function createPluginClients(
  discover: () => Promise<readonly PluginOperation[]>,
  request: (path: string, method: string, body?: unknown) => Promise<unknown>,
): PluginClients {
  const proxy = (segments: string[]): unknown => new Proxy(() => {}, {
    get(_target, property) {
      if (property === "then" || typeof property !== "string") return undefined;
      validateOperationName(property);
      if (segments.length >= 3) throw new TypeError("Plugin operations use namespace.resource.action.");
      return proxy([...segments, property]);
    },
    async apply(_target, _this, args: [unknown?, PluginOperationOptions?]) {
      if (segments.length !== 3) throw new TypeError("Select a plugin namespace, resource and action.");
      const [namespace, resource, action] = segments;
      // Discover on every invocation: disabled/uninstalled plugins must not
      // remain callable through a cached registration list.
      const operation = (await discover()).find((item) =>
        item.namespace === namespace && item.resource === resource && item.action === action);
      if (!operation) throw new Error(`Unknown plugin operation: ${segments.join(".")}`);
      const [input, options] = args;
      let path = operation.path.replace(/:([a-zA-Z][a-zA-Z0-9]*)/g, (_match, key: string) => {
        const value = options?.params?.[key];
        if (value === undefined) throw new TypeError(`Missing path parameter: ${key}`);
        if (value === "." || value === ".." || !value) throw new TypeError(`Invalid path parameter: ${key}`);
        return encodeURIComponent(value);
      });
      const query = new URLSearchParams(options?.query);
      if (query.size) path += `?${query}`;
      if ((operation.method === "GET" || operation.method === "DELETE") && input !== undefined) {
        throw new TypeError("Use params/query options for operations without a request body.");
      }
      return request(path, operation.method, input);
    },
  });
  return proxy([]) as PluginClients;
}

export type { PluginApiTree, ZelavisCreateApiFunction } from "./create-api.js";
