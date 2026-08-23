import type {
  HTTPMethods,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { Readable } from "node:stream";
import type { ZelavisServerRuntime } from "../contracts.js";
import {
  createRequestFromPlainInput,
  toResponseHeaderEntries,
} from "../core/request-dispatcher.js";

const FASTIFY_HTTP_METHODS: HTTPMethods[] = [
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
] as const;

function canHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function toWebRequest(
  request: FastifyRequest,
): Promise<globalThis.Request> {
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.raw.headers)) {
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
        ? (Readable.toWeb(request.raw) as ReadableStream<Uint8Array>)
        : undefined;

  return createRequestFromPlainInput({
    url: request.raw.url ?? "/",
    method: request.method,
    headers,
    body,
    baseUrl: `${request.protocol}://${request.headers.host ?? "localhost"}`,
  });
}

async function sendFastifyResponse(
  reply: FastifyReply,
  payload: Response,
  method = "GET",
): Promise<void> {
  const response = reply.raw;
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

export function fastifyAdapter<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">,
): FastifyPluginAsync {
  const plugin: FastifyPluginAsync = async (fastify) => {
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      async (_request: FastifyRequest, body: Buffer) => body,
    );

    const handleRequest = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      const webRequest = await toWebRequest(request);
      const result = await runtime.dispatch(webRequest, {
        platform: {
          fastify: {
            request,
            reply,
          },
        },
      });

      if (!result.matched) {
        return reply.callNotFound();
      }

      reply.hijack();
      await sendFastifyResponse(reply, result.response, request.method);
      return reply;
    };

    fastify.route({
      method: FASTIFY_HTTP_METHODS,
      url: "/",
      handler: handleRequest,
    });
    fastify.route({
      method: FASTIFY_HTTP_METHODS,
      url: "/*",
      handler: handleRequest,
    });
  };

  return plugin;
}
