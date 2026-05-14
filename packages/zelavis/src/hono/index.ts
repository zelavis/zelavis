import type { MiddlewareHandler } from "hono";
import { honoAdapter as bindHonoRuntime } from "@zelavis/server/adapters/hono";
import type { Zelavis } from "../index.js";

export function honoMiddleware(zelavis: Zelavis): MiddlewareHandler {
  let middleware: MiddlewareHandler | undefined;
  return async (context, next) => {
    if (!middleware) {
      const runtime = await zelavis.runtime();
      middleware = bindHonoRuntime(runtime);
    }
    return middleware(context, next);
  };
}
