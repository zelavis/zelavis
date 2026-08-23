import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";
import type { ZelavisServerRuntime } from "../contracts.js";
import { sendNodeLikeResponse, toNodeLikeWebRequest } from "./node-shared.js";

type MaybePromise<T> = T | Promise<T>;

export interface NextjsPagesRouterAdapterOptions {
  routePrefix?: string;
  mountPath?: string;
}

function normalizePathPrefix(value: string): string {
  if (value === "/") {
    return "/";
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function remapRequestUrl(
  url: string,
  options: NextjsPagesRouterAdapterOptions,
): string {
  const routePrefix = options.routePrefix
    ? normalizePathPrefix(options.routePrefix)
    : undefined;
  const mountPath = options.mountPath
    ? normalizePathPrefix(options.mountPath)
    : undefined;

  if (!routePrefix || !mountPath || routePrefix === mountPath) {
    return url;
  }

  const parsedUrl = new URL(url, "http://local.zelavis");

  if (
    parsedUrl.pathname !== routePrefix &&
    !parsedUrl.pathname.startsWith(`${routePrefix}/`)
  ) {
    return url;
  }

  const suffix = parsedUrl.pathname.slice(routePrefix.length);
  parsedUrl.pathname = `${mountPath}${suffix}` || mountPath;

  return `${parsedUrl.pathname}${parsedUrl.search}`;
}

export function nextjsPagesRouterAdapter<TService = unknown>(
  runtime: MaybePromise<Pick<ZelavisServerRuntime<TService>, "fetch">>,
  options: NextjsPagesRouterAdapterOptions = {},
): NextApiHandler {
  return async (
    request: NextApiRequest,
    response: NextApiResponse,
  ): Promise<void> => {
    const resolvedRuntime = await runtime;
    const webRequest = await toNodeLikeWebRequest(request, {
      url: remapRequestUrl(request.url ?? "/", options),
    });
    const webResponse = await resolvedRuntime.fetch(webRequest, {
      platform: {
        node: {
          request,
          response,
        },
        nextjs: {
          router: "pages",
          request,
          response,
        },
      },
    });

    await sendNodeLikeResponse(response, webResponse, request.method ?? "GET");
  };
}
