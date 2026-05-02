import type {
  ZelavisAdapterFactory,
  ZelavisAdapterRuntimeContext,
  ZelavisServerRuntime,
} from "../index.js";

export function createLazyBoundValue<TValue>(
  load: () => Promise<TValue>,
): () => Promise<TValue> {
  let promise: Promise<TValue> | undefined;

  return () => {
    promise ??= load();
    return promise;
  };
}

export function createRuntimeBackedAdapter<TAdapter extends object>(
  name: string,
  bind: (
    context: ZelavisAdapterRuntimeContext,
  ) => TAdapter,
): ZelavisAdapterFactory<TAdapter> {
  return {
    name,
    bind,
  };
}

export type RuntimeLike<TService = unknown> = Pick<
  ZelavisServerRuntime<TService>,
  "dispatch" | "fetch" | "plain" | "routes" | "services"
>;
