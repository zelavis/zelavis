import { AsyncLocalStorage } from "node:async_hooks";
import {
  getPluginContextStorage,
  setPluginContextStorage,
  type PluginExecutionContext,
} from "../core/service/context.js";

/**
 * Replaces the portable single-slot plugin context with `AsyncLocalStorage`,
 * available on Node, Bun and Deno. Package loads then carry their own context
 * through every continuation, which is what lets the loader run them
 * concurrently and abandon one that misses its admission deadline.
 *
 * Idempotent; process-wide because the context store is.
 */
export function installAsyncPluginContextStorage(): void {
  if (getPluginContextStorage().propagatesAsyncContext) return;
  const storage = new AsyncLocalStorage<PluginExecutionContext>();
  setPluginContextStorage({
    propagatesAsyncContext: true,
    getStore: () => storage.getStore(),
    run: (context, fn) => storage.run(context, fn),
  });
}
