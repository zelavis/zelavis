import type { MiddlewareHandler } from "hono";
import { honoAdapter as bindHonoRuntime } from "@zelavis/server/adapters/hono";
import type { Zelavis } from "../index.js";

export function honoMiddleware(zelavis: Zelavis): MiddlewareHandler {
  let middleware: MiddlewareHandler | undefined;
  return async (context, next) => {
    let handle = middleware;
    if (!handle) {
      const runtime = await zelavis.runtime();
      handle = bindHonoRuntime(runtime);
      middleware = handle;
    }
    return handle(context, next);
  };
}
