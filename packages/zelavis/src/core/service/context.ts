import type { ZelavisServiceSetupContext } from "../../service.js";
import type {
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeServiceMenuDefinition,
  ZelavisServerRoute,
} from "../runtime/contracts.js";
import type { ZelavisRequestAuthenticator } from "../runtime/authentication.js";
import type { ZelavisServiceAppDefinition, ZelavisServiceMenuDefinition } from "./definition.js";
import type { ZelavisPackageManifest } from "./manifest.js";

export interface ZelavisCommandDefinition {
  name: string;
  description?: string;
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

/** Runtime behavior supplied by a frontend through the SDK. Identity and bundle metadata stay in its manifest. */
export type PluginFrontendBehavior = Pick<ZelavisServiceAppDefinition,
  "shell" | "devUrl" | "devUrlExcludePaths">;

export type PluginSetupHandler = (context: ZelavisServiceSetupContext) =>
  void | { runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[] } |
  Promise<void | { runtimeServices?: readonly ZelavisAnyRuntimeServiceInput[] }>;

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
  frontend?: PluginFrontendBehavior;
  setup?: PluginSetupHandler;
  /**
   * Set when the package's load was abandoned (its admission deadline passed).
   * A continuation of that package that resumes later must not register
   * anything, so every context accessor refuses a sealed context.
   */
  sealed?: string;
}

export interface PluginContextStorage {
  getStore(): PluginExecutionContext | undefined;
  run<R>(context: PluginExecutionContext, fn: () => R): R;
  /**
   * The context follows asynchronous continuations (e.g. `AsyncLocalStorage`),
   * so a load can be abandoned or run beside another without its later
   * continuations seeing the wrong package's context. The portable default is
   * one global slot and does not.
   */
  readonly propagatesAsyncContext?: boolean;
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
  assertNotSealed(context);
  return context;
}

/**
 * Returns the currently active plugin execution context, or undefined if called outside.
 */
export function getActivePluginContext(): PluginExecutionContext | undefined {
  const context = activePluginStorage.getStore();
  if (context) assertNotSealed(context);
  return context;
}

function assertNotSealed(context: PluginExecutionContext) {
  if (context.sealed) {
    throw new Error(
      `Package "${context.name}" can no longer register: ${context.sealed}`,
    );
  }
}
