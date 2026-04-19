import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import type {
  ZelavisResolvedRoute,
  ZelavisRouteResponse,
  ZelavisServerIntegration,
  ZelavisServerMountOptions,
} from "../contracts.js";

interface MatchedRoute<TService = unknown> {
  resolvedRoute: ZelavisResolvedRoute<TService>;
  params: Record<string, string>;
}

function toHeaderMap(headers: IncomingHttpHeaders): Record<string, string | undefined> {
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

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | undefined {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(pathname);

  if (patternParts.length !== pathParts.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    const pathPart = pathParts[index];

    if (patternPart.startsWith(":")) {
      params[patternPart.slice(1)] = decodeURIComponent(pathPart);
      continue;
    }

    if (patternPart !== pathPart) {
      return undefined;
    }
  }

  return params;
}

function findRoute<TService = unknown>(
  routes: readonly ZelavisResolvedRoute<TService>[],
  request: IncomingMessage,
  url: URL,
): MatchedRoute<TService> | undefined {
  const method = request.method?.toUpperCase();

  for (const resolvedRoute of routes) {
    if (resolvedRoute.route.method !== method) {
      continue;
    }

    const params = matchPath(resolvedRoute.fullPath, url.pathname);
    if (params) {
      return { resolvedRoute, params };
    }
  }

  return undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function parseBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "DELETE") {
    return undefined;
  }

  const rawBody = await readBody(request);
  if (!rawBody) {
    return undefined;
  }

  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    return JSON.parse(rawBody);
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(rawBody).entries());
  }

  return rawBody;
}

function sendResponse(response: ServerResponse, payload: ZelavisRouteResponse): void {
  for (const [key, value] of Object.entries(payload.headers ?? {})) {
    response.setHeader(key, value);
  }

  response.statusCode = payload.status ?? 200;

  if (payload.body === undefined) {
    response.end();
    return;
  }

  if (
    typeof payload.body === "string" ||
    payload.body instanceof Uint8Array ||
    payload.body instanceof ArrayBuffer
  ) {
    response.end(payload.body);
    return;
  }

  if (!response.hasHeader("content-type")) {
    response.setHeader("content-type", "application/json; charset=utf-8");
  }

  response.end(JSON.stringify(payload.body));
}

function defaultErrorResponse(error: unknown): ZelavisRouteResponse {
  return {
    status: 500,
    body: {
      error: error instanceof Error ? error.message : "Unknown error",
    },
  };
}

function notFoundResponse(): ZelavisRouteResponse {
  return {
    status: 404,
    body: {
      error: "Not found",
    },
  };
}

function mountNodeRoutes<TService = unknown>(
  routes: readonly ZelavisResolvedRoute<TService>[],
  options: Pick<ZelavisServerMountOptions<TService>, "onError"> = {},
): Server {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = findRoute(routes, request, url);

    if (!match) {
      sendResponse(response, notFoundResponse());
      return;
    }

    try {
      const result = await match.resolvedRoute.route.handler({
        service: match.resolvedRoute.service.service,
        params: match.params,
        query: url.searchParams,
        body: await parseBody(request),
        headers: toHeaderMap(request.headers),
        request,
      });

      sendResponse(response, result);
    } catch (error) {
      const errorPayload =
        options.onError?.({
          error,
          resolvedRoute: match.resolvedRoute,
        }) ?? defaultErrorResponse(error);

      sendResponse(response, errorPayload);
    }
  });
}

export function nodeIntegration<TService = unknown>(): ZelavisServerIntegration<
  TService,
  Server
> {
  return {
    mount(routes, options) {
      return mountNodeRoutes(routes, options);
    },
  };
}
