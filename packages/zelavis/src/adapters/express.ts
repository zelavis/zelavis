import type { RequestHandler } from "express";
import { expressAdapter as bindExpressRuntime } from "@zelavis/server/adapters/express";
import type { ZelavisAdapterBinding } from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

export interface ZelavisExpressBinding extends ZelavisAdapterBinding {
  expressMiddleware(): RequestHandler;
}

export function expressAdapter() {
  return createRuntimeBackedAdapter<ZelavisExpressBinding>(
    "express",
    ({ getRuntime }) => {
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
  );
}
