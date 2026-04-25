import type { H3, H3Event } from "h3";
import type { ZelavisServerRuntime } from "../contracts.js";

export function h3Integration<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">,
  app: H3,
): H3 {
  app.use(async (event: H3Event, next) => {
    const result = await runtime.dispatch(event.req, {
      platform: {
        h3: event,
      },
    });

    if (!result.matched) {
      return next();
    }

    return result.response;
  });

  return app;
}
