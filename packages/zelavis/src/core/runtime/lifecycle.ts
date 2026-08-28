import type {
  ZelavisResolvedRoute,
  ZelavisServerDispatchResult,
  ZelavisServerExecutionContext,
  ZelavisRuntimeService,
} from "./contracts.js";

export interface ZelavisServerStartEvent {
  readonly services: Readonly<Record<string, ZelavisRuntimeService<any>>>;
  readonly routes: readonly ZelavisResolvedRoute[];
  readonly compatibilityDate?: string;
}

export interface ZelavisServerRequestEvent {
  readonly request: Request;
  readonly context?: ZelavisServerExecutionContext;
}

export interface ZelavisServerResponseEvent<TService = unknown>
  extends ZelavisServerRequestEvent {
  readonly result: ZelavisServerDispatchResult<TService>;
}

export interface ZelavisServerErrorEvent<TService = unknown>
  extends ZelavisServerRequestEvent {
  readonly error: unknown;
  readonly resolvedRoute?: ZelavisResolvedRoute<TService>;
}

export interface ZelavisServerCloseEvent {
  readonly compatibilityDate?: string;
}

export interface ZelavisServerLifecycleEvents<TService = unknown> {
  start: ZelavisServerStartEvent;
  request: ZelavisServerRequestEvent;
  response: ZelavisServerResponseEvent<TService>;
  error: ZelavisServerErrorEvent<TService>;
  close: ZelavisServerCloseEvent;
}

export type ZelavisServerLifecycleHook<
  TEvent,
> = (event: TEvent) => void | Promise<void>;

export interface ZelavisServerLifecycle<TService = unknown> {
  hook<TKey extends keyof ZelavisServerLifecycleEvents<TService>>(
    name: TKey,
    hook: ZelavisServerLifecycleHook<
      ZelavisServerLifecycleEvents<TService>[TKey]
    >,
  ): () => void;
}

export interface ZelavisServerPluginContext<TService = unknown> {
  readonly hooks: ZelavisServerLifecycle<TService>;
  readonly compatibilityDate?: string;
}

export type ZelavisServerPluginCleanup = () => void | Promise<void>;

export type ZelavisServerPlugin<TService = unknown> = (
  context: ZelavisServerPluginContext<TService>,
) =>
  | void
  | ZelavisServerPluginCleanup
  | Promise<void | ZelavisServerPluginCleanup>;

export function defineServerPlugin<TService = unknown>(
  plugin: ZelavisServerPlugin<TService>,
): ZelavisServerPlugin<TService> {
  if (typeof plugin !== "function") {
    throw new TypeError("A Zelavis server plugin must be a function.");
  }

  return plugin;
}

interface MutableZelavisServerLifecycle<TService = unknown>
  extends ZelavisServerLifecycle<TService> {
  emit<TKey extends keyof ZelavisServerLifecycleEvents<TService>>(
    name: TKey,
    event: ZelavisServerLifecycleEvents<TService>[TKey],
  ): Promise<void>;
}

export function createServerLifecycle<
  TService = unknown,
>(): MutableZelavisServerLifecycle<TService> {
  const hooks = new Map<
    keyof ZelavisServerLifecycleEvents<TService>,
    Array<ZelavisServerLifecycleHook<any>>
  >();

  return {
    hook(name, hook) {
      if (typeof hook !== "function") {
        throw new TypeError(
          `The "${String(name)}" lifecycle hook must be a function.`,
        );
      }

      const registered = hooks.get(name) ?? [];
      registered.push(hook);
      hooks.set(name, registered);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        const index = registered.indexOf(hook);
        if (index >= 0) {
          registered.splice(index, 1);
        }
      };
    },
    async emit(name, event) {
      for (const hook of [...(hooks.get(name) ?? [])]) {
        await hook(event);
      }
    },
  };
}
