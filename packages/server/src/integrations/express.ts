import type { Request, Response, Router } from "express";
import type {
  ZelavisResolvedRoute,
  ZelavisRouteResponse,
  ZelavisServerIntegration,
  ZelavisServerMountOptions,
} from "../contracts.js";

function queryToSearchParams(query: Request["query"]): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }

    if (typeof value === "string") {
      params.append(key, value);
      continue;
    }

    if (value !== undefined) {
      params.append(key, String(value));
    }
  }

  return params;
}

function toHeaderMap(headers: Request["headers"]): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[key] = value.join(",");
      continue;
    }

    result[key] = value;
  }

  return result;
}

function sendResponse(response: Response, payload: ZelavisRouteResponse): void {
  for (const [key, value] of Object.entries(payload.headers ?? {})) {
    response.setHeader(key, value);
  }

  const status = payload.status ?? 200;
  if (payload.body === undefined) {
    response.sendStatus(status);
    return;
  }

  if (
    typeof payload.body === "string" ||
    payload.body instanceof Uint8Array ||
    payload.body instanceof ArrayBuffer
  ) {
    response.status(status).send(payload.body);
    return;
  }

  response.status(status).json(payload.body);
}

function defaultErrorResponse(error: unknown): ZelavisRouteResponse {
  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : "Unknown error",
    },
  };
}

function mountExpressRoutes<TService = unknown>(
  router: Router,
  routes: readonly ZelavisResolvedRoute<TService>[],
  options: Pick<ZelavisServerMountOptions<TService>, "onError"> = {},
): Router {
  for (const resolved of routes) {
    const method = resolved.route.method.toLowerCase() as
      | "get"
      | "post"
      | "put"
      | "patch"
      | "delete";

    router[method](resolved.fullPath, async (request, response) => {
      try {
        const result = await resolved.route.handler({
          service: resolved.service.service,
          params: Object.fromEntries(
            Object.entries(request.params).map(([key, value]) => [key, String(value)]),
          ),
          query: queryToSearchParams(request.query),
          body: request.body,
          headers: toHeaderMap(request.headers),
          request,
        });

        sendResponse(response, result);
      } catch (error) {
        const errorPayload =
          options.onError?.({
            error,
            resolvedRoute: resolved,
          }) ?? defaultErrorResponse(error);

        sendResponse(response, errorPayload);
      }
    });
  }

  return router;
}

export function expressIntegration<TService = unknown>(
  router: Router,
): ZelavisServerIntegration<TService, Router> {
  return {
    mount(routes, options) {
      return mountExpressRoutes(router, routes, options);
    },
  };
}
