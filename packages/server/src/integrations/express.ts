import type { Request, RequestHandler, Response } from "express";
import { Readable } from "node:stream";
import type { ZelavisServerRuntime } from "../contracts.js";
import {
  createRequestFromPlainInput,
  toResponseHeaderEntries,
} from "../core/request-dispatcher.js";

function canHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function toWebRequest(request: Request): Promise<globalThis.Request> {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const body =
    request.body !== undefined
      ? request.body
      : canHaveBody(request.method)
        ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
        : undefined;

  return createRequestFromPlainInput({
    url: request.originalUrl || request.url,
    method: request.method,
    headers,
    body,
    baseUrl: `${request.protocol}://${request.get("host") ?? "localhost"}`,
  });
}

async function sendExpressResponse(
  response: Response,
  payload: globalThis.Response,
  method = "GET",
): Promise<void> {
  response.status(payload.status);

  for (const [key, value] of toResponseHeaderEntries(payload.headers)) {
    if (key.toLowerCase() === "set-cookie") {
      const existing = response.getHeader(key);

      if (existing === undefined) {
        response.setHeader(key, [value]);
        continue;
      }

      const nextValues = Array.isArray(existing)
        ? [...existing.map(String), value]
        : [String(existing), value];
      response.setHeader(key, nextValues);
      continue;
    }

    response.setHeader(key, value);
  }

  if (method.toUpperCase() === "HEAD" || !payload.body) {
    response.end();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(payload.body as any);

    stream.on("error", reject);
    response.on("error", reject);
    response.on("finish", resolve);

    stream.pipe(response);
  });
}

export function expressIntegration<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">,
): RequestHandler {
  return async (request, response, next) => {
    const webRequest = await toWebRequest(request);
    const result = await runtime.dispatch(webRequest, {
      platform: {
        express: {
          request,
          response,
        },
      },
    });

    if (!result.matched) {
      next();
      return;
    }

    await sendExpressResponse(response, result.response, request.method);
  };
}
