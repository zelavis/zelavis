import type { RequestHandler } from "express";
import { expressAdapter as bindExpressRuntime } from "@zelavis/server/adapters/express";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";
import { createLazyBoundValue } from "./_shared.js";

export interface ZelavisExpressAdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisExpressBinding extends ZelavisAdapterBinding {
  expressMiddleware(): RequestHandler;
}

export function expressAdapter(options: ZelavisExpressAdapterOptions = {}) {
  return defineAdapter<ZelavisExpressBinding>({
    name: "express",
    platform: options.platform,
    mount: ({ getRuntime }) => {
      const getMiddleware = createLazyBoundValue(async () =>
        bindExpressRuntime(await getRuntime()),
      );

      return {
        async ready() {
          await getMiddleware();
        },
        expressMiddleware() {
          return async (request, response, next) => {
            const middleware = await getMiddleware();
            return middleware(request, response, next);
          };
        },
      };
    },
  });
}
