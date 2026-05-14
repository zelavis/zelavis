import type { RequestHandler } from "express";
import { expressAdapter as bindExpressRuntime } from "@zelavis/server/adapters/express";
import type { Zelavis } from "../index.js";

export function expressMiddleware(zelavis: Zelavis): RequestHandler {
  let middleware: RequestHandler | undefined;
  return async (request, response, next) => {
    if (!middleware) {
      const runtime = await zelavis.runtime();
      middleware = bindExpressRuntime(runtime);
    }
    return middleware(request, response, next);
  };
}
