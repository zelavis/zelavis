import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  createRequestFromPlainInput,
  toResponseHeaderEntries,
} from "./request-dispatcher.js";

interface NodeLikeRequest extends IncomingMessage {
  body?: unknown;
}

interface ToNodeLikeWebRequestOptions {
  url?: string;
  baseUrl?: string;
  /** Aborted when the client goes away, so handlers can stop early. */
  signal?: AbortSignal;
}

function canHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function getRequestProtocol(request: IncomingMessage): string {
  const forwardedProtocol = firstHeaderValue(
    request.headers["x-forwarded-proto"],
  )
    ?.split(",")[0]
    ?.trim();

  if (forwardedProtocol) {
    return forwardedProtocol;
  }

  return (request.socket as { encrypted?: boolean }).encrypted
    ? "https"
    : "http";
}

function toBodyInit(body: unknown): BodyInit | undefined {
  if (body == null) {
    return undefined;
  }

  if (
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ReadableStream
  ) {
    return body;
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body) as unknown as BodyInit;
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer,
      body.byteOffset,
      body.byteLength,
    ) as unknown as BodyInit;
  }

  if (typeof body === "object") {
    return JSON.stringify(body);
  }

  return String(body);
}

export async function toNodeLikeWebRequest(
  request: NodeLikeRequest,
  options: ToNodeLikeWebRequestOptions = {},
): Promise<Request> {
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
    ? request.body === undefined
      ? (Readable.toWeb(request) as ReadableStream<Uint8Array>)
      : toBodyInit(request.body)
    : undefined;

  return createRequestFromPlainInput({
    url: options.url ?? request.url ?? "/",
    method,
    headers,
    body,
    ...(options.signal ? { signal: options.signal } : {}),
    baseUrl:
      options.baseUrl ??
      `${getRequestProtocol(request)}://${request.headers.host ?? "localhost"}`,
  });
}

export async function sendNodeLikeResponse(
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
