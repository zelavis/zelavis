import { elysiaAdapter as bindElysiaRuntime } from "@zelavis/server/adapters/elysia";
import type { ZelavisAdapterBinding } from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

export interface ZelavisElysiaBinding extends ZelavisAdapterBinding {
  elysiaPlugin(): Promise<ReturnType<typeof bindElysiaRuntime>>;
}

export function elysiaAdapter() {
  return createRuntimeBackedAdapter<ZelavisElysiaBinding>(
    "elysia",
    ({ getRuntime }) => {
      const getPlugin = createLazyBoundValue(async () =>
        bindElysiaRuntime(await getRuntime()),
      );

      return {
        async ready() {
          await getPlugin();
        },
        async elysiaPlugin() {
          return getPlugin();
        },
      };
    },
  );
}
