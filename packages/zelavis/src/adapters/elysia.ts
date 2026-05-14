import { elysiaAdapter as bindElysiaRuntime } from "@zelavis/server/adapters/elysia";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";
import { createLazyBoundValue } from "./_shared.js";

export interface ZelavisElysiaAdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisElysiaBinding extends ZelavisAdapterBinding {
  elysiaPlugin(): Promise<ReturnType<typeof bindElysiaRuntime>>;
}

export function elysiaAdapter(options: ZelavisElysiaAdapterOptions = {}) {
  return defineAdapter<ZelavisElysiaBinding>({
    name: "elysia",
    platform: options.platform,
    mount: ({ getRuntime }) => {
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
  });
}
