import type {
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeServiceMenuDefinition,
  ZelavisServerRoute,
} from "../runtime/contracts.js";
import type { ZelavisRequestAuthenticator } from "../runtime/authentication.js";
import type { ZelavisServiceMenuDefinition } from "./definition.js";
import type { ZelavisPackageManifest } from "./manifest.js";

export interface ZelavisCommandDefinition {
  name: string;
  description?: string;
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

export interface PluginExecutionContext {
  name: string;
  version?: string;
  kind: string;
  manifest: ZelavisPackageManifest;
  menus: (ZelavisRuntimeServiceMenuDefinition | ZelavisServiceMenuDefinition)[];
  routes: ZelavisServerRoute[];
  commands: Map<string, ZelavisCommandDefinition>;
  events: Array<{ event: string; handler: (...args: unknown[]) => void | Promise<void> }>;
  services: ZelavisAnyRuntimeServiceInput[];
  authenticators: ZelavisRequestAuthenticator[];
  providers: Map<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface PluginContextStorage {
  getStore(): PluginExecutionContext | undefined;
  run<R>(context: PluginExecutionContext, fn: () => R): R;
}

const GLOBAL_PLUGIN_KEY = Symbol.for("zelavis.active_plugin_context");

export const activePluginStorage: PluginContextStorage = {
  getStore() {
    return (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY] as
      | PluginExecutionContext
      | undefined;
  },
  run<R>(context: PluginExecutionContext, fn: () => R): R {
    const prev = (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY];
    (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY] = context;
    try {
      const result = fn();
      if (result && typeof (result as Record<string, unknown>).then === "function") {
        return (result as unknown as Promise<unknown>).finally(() => {
          (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY] = prev;
        }) as R;
      }
      (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY] = prev;
      return result;
    } catch (error) {
      (globalThis as Record<symbol, unknown>)[GLOBAL_PLUGIN_KEY] = prev;
      throw error;
    }
  },
};

export function setPluginContextStorage(storage: PluginContextStorage): void {
  Object.assign(activePluginStorage, storage);
}

export function getPluginContextStorage(): PluginContextStorage {
  return activePluginStorage;
}

export function createPluginExecutionContext(
  manifest: ZelavisPackageManifest,
): PluginExecutionContext {
  return {
    name: manifest.name,
    version: manifest.version,
    kind: manifest.zelavis?.kind ?? "plugin",
    manifest,
    menus: [],
    routes: [],
    commands: new Map(),
    events: [],
    services: [],
    authenticators: [],
    providers: new Map(),
    metadata: {},
  };
}

/**
 * Returns the currently active plugin execution context, or throws if called
 * outside of a plugin execution boundary.
 */
export function requireActivePluginContext(
  apiName = "Zelavis plugin API",
): PluginExecutionContext {
  const context = activePluginStorage.getStore();
  if (!context) {
    throw new Error(
      `${apiName} can only be called within an active Zelavis plugin execution context.`,
    );
  }
  return context;
}

/**
 * Returns the currently active plugin execution context, or undefined if called outside.
 */
export function getActivePluginContext(): PluginExecutionContext | undefined {
  return activePluginStorage.getStore();
}
