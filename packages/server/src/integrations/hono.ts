import type { Context, Hono } from "hono";
import type { ZelavisServerRuntime } from "../contracts.js";

export function honoIntegration<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">,
  app: Hono,
): Hono {
  app.use("*", async (context: Context, next) => {
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

  return app;
}
