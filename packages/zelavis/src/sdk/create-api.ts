import {
  requireActivePluginContext,
  getActivePluginContext,
  type PluginExecutionContext,
} from "../core/service/context.js";
import type {
  ZelavisRuntimeServiceMenuDefinition,
  ZelavisServerRoute,
  ZelavisRouteContext,
} from "../core/runtime/contracts.js";
import type { ZelavisServiceMenuDefinition } from "../core/service/definition.js";
import { validateOperationName } from "./plugins.js";

export type PluginApiTree = Record<string, unknown>;

export interface CreateApiOptions {
  /**
   * Explicit namespace to mount the API under. If omitted, the namespace is
   * inferred from the active plugin execution context.
   */
  namespace?: string;
  /**
   * Whether to automatically register HTTP Web API routes for action methods.
   * Defaults to `true` when called within an active plugin context.
   */
  routes?: boolean;
  /** Access requirements applied to every generated route. */
  access?: ZelavisServerRoute["access"];
}

export type ZelavisMenuApi = {
  create(
    menu: ZelavisRuntimeServiceMenuDefinition | ZelavisServiceMenuDefinition,
  ): ZelavisRuntimeServiceMenuDefinition | ZelavisServiceMenuDefinition;
};

/** Authoring registries are scoped to module evaluation, never shared by runtimes. */
const localApis = new Map<string, PluginApiTree>();
const contextApis = new WeakMap<PluginExecutionContext, Map<string, PluginApiTree>>();
function registry(context = getActivePluginContext()): Map<string, PluginApiTree> {
  if (!context) return localApis;
  let apis = contextApis.get(context);
  if (!apis) contextApis.set(context, apis = new Map());
  return apis;
}

export interface PluginAuthoringApiRegistry {}
export type RegisteredPluginApis = PluginAuthoringApiRegistry & {
  readonly ui: { readonly menus: ZelavisMenuApi };
  readonly [namespace: string]: any;
};

export const pluginsProxy = new Proxy({} as RegisteredPluginApis, {
  get(_target, prop) {
    if (typeof prop !== "string" || prop === "then") return undefined;
    return registry().get(prop) ?? (prop === "ui" ? localApis.get("ui") : undefined);
  },
  has(_target, prop) { return typeof prop === "string" && (registry().has(prop) || prop === "ui"); },
  ownKeys() { return [...new Set(["ui", ...registry().keys()])]; },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === "string" && (registry().has(prop) || prop === "ui")) {
      return { configurable: true, enumerable: true, value: registry().get(prop) ?? localApis.get("ui") };
    }
    return undefined;
  },
  set() { throw new TypeError("Register plugin APIs with zelavis.createAPI()."); },
});

/**
 * Automatically creates and registers an HTTP Web API route on the active plugin context
 * for a method on a resource.
 */
function registerAutoWebApiRoute(
  routes: ZelavisServerRoute[],
  namespace: string,
  resource: string,
  action: string,
  handler: (...args: any[]) => any,
  access: ZelavisServerRoute["access"],
): void {
  validateOperationName(resource);
  validateOperationName(action);

  let method: ZelavisServerRoute["method"] = "POST";
  let path = `/${resource}/${action}`;

  if (action === "list" || action === "find") {
    method = "GET";
    path = `/${resource}`;
  } else if (action === "get" || action === "read") {
    method = "GET";
    path = `/${resource}/:id`;
  } else if (action === "create" || action === "add") {
    method = "POST";
    path = `/${resource}`;
  } else if (action === "update" || action === "put") {
    method = "PUT";
    path = `/${resource}/:id`;
  } else if (action === "delete" || action === "remove") {
    method = "DELETE";
    path = `/${resource}/:id`;
  }

  const routeId = `${namespace}.${resource}.${action}`;
  if (
    routes.some(
      (r) =>
        r.id === routeId ||
        (r.meta?.pluginResource === resource && r.meta?.pluginAction === action) ||
        (r.method === method && r.path.replace(/:[^/]+/g, ":param") === path.replace(/:[^/]+/g, ":param")),
    )
  ) {
    throw new TypeError(`Duplicate plugin route: ${method} ${path}`);
  }

  routes.push({
    id: routeId,
    method,
    path,
    access,
    spec: {
      operationId: `${namespace}_${resource}_${action}`,
      summary: `${namespace} ${resource} ${action}`,
      ...(path.includes(":id") ? { pathParams: { id: { type: "string" as const, required: true } } } : {}),
      responses: {
        200: { description: "Successful response" },
      },
    },
    meta: {
      pluginResource: resource,
      pluginAction: action,
    },
    handler: async (reqContext: ZelavisRouteContext) => {
      const queryObj = Object.fromEntries(reqContext.query.entries());
      const input = method === "GET" || method === "DELETE"
        ? { ...queryObj, ...reqContext.params }
        : reqContext.params.id
          ? { ...(reqContext.body as Record<string, unknown>), id: reqContext.params.id }
          : reqContext.body;
      const result = await handler(input, reqContext);
      // Returned objects are data, even when they contain status/body/headers.
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: result,
      };
    },
  });
}

/**
 * Creates and registers a plugin API under `zelavis.plugins.<namespace>`.
 *
 * If called inside an active plugin execution context, any resource methods
 * will also be automatically mounted as versioned HTTP Web API routes.
 */
export function createAPI<T extends PluginApiTree>(
  api: T,
  options?: CreateApiOptions,
): T;
export function createAPI<T extends PluginApiTree>(
  namespace: string,
  api: T,
  options?: CreateApiOptions,
): T;
export function createAPI<T extends PluginApiTree>(
  namespaceOrApi: string | T,
  maybeApiOrOptions?: T | CreateApiOptions,
  options?: CreateApiOptions,
): T {
  let namespace: string;
  let api: T;
  let opts: CreateApiOptions | undefined;

  if (typeof namespaceOrApi === "string") {
    namespace = namespaceOrApi;
    api = maybeApiOrOptions as T;
    opts = options;
  } else {
    const context = getActivePluginContext();
    const inferred = context?.manifest?.zelavis?.namespace;
    opts = maybeApiOrOptions as CreateApiOptions | undefined;
    namespace = opts?.namespace ?? inferred ?? "";
    if (!namespace) {
      throw new TypeError(
        "zelavis.createAPI requires an explicit namespace or an active plugin execution context with a declared namespace.",
      );
    }
    api = namespaceOrApi;
  }

  return registerApi(namespace, api, opts, getActivePluginContext());
}

function registerApi<T extends PluginApiTree>(
  namespace: string,
  api: T,
  opts: CreateApiOptions | undefined,
  context: PluginExecutionContext | undefined,
): T {
  validateOperationName(namespace);
  if (!api || typeof api !== "object" || Array.isArray(api)) {
    throw new TypeError("zelavis.createAPI requires an API definition object.");
  }

  if (context && namespace !== context.manifest.zelavis?.namespace) {
    throw new TypeError("zelavis.createAPI cannot override its manifest namespace.");
  }
  if (!context && namespace === "ui" && localApis.has("ui")) {
    throw new TypeError("The ui authoring namespace is reserved.");
  }
  const apis = context ? registry(context) : localApis;
  const existing = apis.get(namespace) ?? (namespace === "ui" ? localApis.get("ui") : undefined) ?? Object.create(null);
  const registered = { ...existing } as T;
  // Prepare everything before publishing; a failed declaration leaves no partial API.
  const pending = [...(context?.routes ?? [])];
  for (const [resourceName, resourceValue] of Object.entries(api)) {
    validateOperationName(resourceName);
    if (resourceValue && typeof resourceValue === "object" && !Array.isArray(resourceValue)) {
      if (Object.hasOwn(existing, resourceName) && typeof existing[resourceName] !== "object") {
        throw new TypeError(`Duplicate plugin API: ${namespace}.${resourceName}`);
      }
      const resource = { ...(existing[resourceName] as PluginApiTree | undefined) };
      for (const [actionName, actionHandler] of Object.entries(resourceValue)) {
        validateOperationName(actionName);
        if (Object.hasOwn(resource, actionName)) throw new TypeError(`Duplicate plugin API: ${namespace}.${resourceName}.${actionName}`);
        resource[actionName] = typeof actionHandler === "function" ? actionHandler.bind(resourceValue) : actionHandler;
        if (context && opts?.routes !== false && typeof actionHandler === "function") {
          registerAutoWebApiRoute(pending, namespace, resourceName, actionName,
            resource[actionName] as (...args: any[]) => any, opts?.access);
        }
      }
      (registered as PluginApiTree)[resourceName] = Object.freeze(resource);
    } else {
      if (Object.hasOwn(existing, resourceName)) throw new TypeError(`Duplicate plugin API: ${namespace}.${resourceName}`);
      (registered as PluginApiTree)[resourceName] = resourceValue;
    }
  }
  apis.set(namespace, Object.freeze(registered));
  if (context) context.routes.push(...pending.slice(context.routes.length));

  return registered;
}

// Use the same registration mechanism without capturing an importing plugin context.
registerApi(
  "ui",
  {
    menus: {
      create(
        menu: ZelavisRuntimeServiceMenuDefinition | ZelavisServiceMenuDefinition,
      ): ZelavisRuntimeServiceMenuDefinition | ZelavisServiceMenuDefinition {
        const context = requireActivePluginContext(
          "zelavis.plugins.ui.menus.create",
        );
        context.menus.push(menu);
        return menu;
      },
    },
  },
  { routes: false },
  undefined,
);

export type ZelavisCreateApiFunction = typeof createAPI;
