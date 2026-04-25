import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ZelavisServerRuntime } from "../contracts.js";
import {
  createRequestFromPlainInput,
  toResponseHeaderEntries,
} from "../core/request-dispatcher.js";

function canHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
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

  const method = request.method ?? "GET";
  const body = canHaveBody(method)
    ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
    : undefined;

  return createRequestFromPlainInput({
    url: request.url ?? "/",
    method,
    headers,
    body,
    baseUrl: `http://${request.headers.host ?? "localhost"}`,
  });
}

async function sendNodeResponse(
  response: ServerResponse,
  payload: Response,
  method = "GET",
): Promise<void> {
  response.statusCode = payload.status;

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

export function nodeIntegration<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "fetch">,
): Server {
  return createServer(async (request, response) => {
    const webRequest = await toWebRequest(request);
    const webResponse = await runtime.fetch(webRequest, {
      platform: {
        node: {
          request,
          response,
        },
      },
    });

    await sendNodeResponse(response, webResponse, request.method ?? "GET");
  });
}
