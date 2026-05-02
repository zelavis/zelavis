import type { MiddlewareHandler } from "hono";
import { honoAdapter as bindHonoRuntime } from "@zelavis/server/adapters/hono";
import type { ZelavisAdapterBinding } from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

export interface ZelavisHonoBinding extends ZelavisAdapterBinding {
  honoMiddleware(): MiddlewareHandler;
}

export function honoAdapter() {
  return createRuntimeBackedAdapter<ZelavisHonoBinding>(
    "hono",
    ({ getRuntime }) => {
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
  );
}
