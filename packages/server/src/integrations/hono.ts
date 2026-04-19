import type { Context, Hono } from "hono";
import type {
  ZelavisResolvedRoute,
  ZelavisRouteResponse,
  ZelavisServerIntegration,
  ZelavisServerMountOptions,
} from "../contracts.js";

function toHeaderMap(context: Context): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};

  for (const [key, value] of context.req.raw.headers.entries()) {
    headers[key] = value;
  }

  return headers;
}

function sendResponse(context: Context, payload: ZelavisRouteResponse) {
  const headers = new Headers(payload.headers);
  const status = payload.status ?? 200;
  if (payload.body === undefined) {
    return new Response(null, { status, headers });
  }

  if (
    typeof payload.body === "string" ||
    payload.body instanceof Uint8Array ||
    payload.body instanceof ArrayBuffer
  ) {
    return new Response(payload.body as BodyInit, { status, headers });
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(JSON.stringify(payload.body), { status, headers });
}

function defaultErrorResponse(error: unknown): ZelavisRouteResponse {
  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : "Unknown error",
    },
  };
}

async function parseHonoBody(context: Context): Promise<unknown> {
  const contentType = context.req.header("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    return context.req.json();
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formData = await context.req.formData();
    return Object.fromEntries(formData.entries());
  }

  return undefined;
}

function mountHonoRoutes<TService = unknown>(
  app: Hono,
  routes: readonly ZelavisResolvedRoute<TService>[],
  options: Pick<ZelavisServerMountOptions<TService>, "onError"> = {},
): Hono {
  for (const resolved of routes) {
    app.on(resolved.route.method, resolved.fullPath, async (context) => {
      try {
        const result = await resolved.route.handler({
          service: resolved.service.service,
          params: context.req.param(),
          query: new URL(context.req.url).searchParams,
          body: await parseHonoBody(context),
          headers: toHeaderMap(context),
          request: context.req.raw,
        });

        return sendResponse(context, result);
      } catch (error) {
        const errorPayload =
          options.onError?.({
            error,
            resolvedRoute: resolved,
          }) ?? defaultErrorResponse(error);

        return sendResponse(context, errorPayload);
      }
    });
  }

  return app;
}

export function honoIntegration<TService = unknown>(
  app: Hono,
): ZelavisServerIntegration<TService, Hono> {
  return {
    mount(routes, options) {
      return mountHonoRoutes(app, routes, options);
    },
  };
}
