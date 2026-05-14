import type { MiddlewareHandler } from "hono";
import { honoAdapter as bindHonoRuntime } from "@zelavis/server/adapters/hono";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";
import { createLazyBoundValue } from "./_shared.js";

export interface ZelavisHonoAdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisHonoBinding extends ZelavisAdapterBinding {
  honoMiddleware(): MiddlewareHandler;
}

export function honoAdapter(options: ZelavisHonoAdapterOptions = {}) {
  return defineAdapter<ZelavisHonoBinding>({
    name: "hono",
    platform: options.platform,
    mount: ({ getRuntime }) => {
      const getMiddleware = createLazyBoundValue(async () =>
        bindHonoRuntime(await getRuntime()),
      );

      return {
        async ready() {
          await getMiddleware();
        },
        honoMiddleware() {
          return async (context, next) => {
            const middleware = await getMiddleware();
            return middleware(context, next);
          };
        },
      };
    },
  });
}
