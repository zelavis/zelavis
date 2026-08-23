import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { ZelavisServerRuntime } from "../contracts.js";

export function honoAdapter<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">,
): MiddlewareHandler {
  return createMiddleware(async (context, next) => {
    const result = await runtime.dispatch(context.req.raw, {
      platform: {
        hono: context,
      },
    });

    if (!result.matched) {
      return next();
    }

    return result.response;
  });
}
