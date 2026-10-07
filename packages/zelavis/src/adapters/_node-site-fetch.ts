import { Effect } from "effect";
import { present } from "../core/runtime/effect-boundary.js";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** Native ingress transport preserves the visitor Host when dialing a private target. */
export function fetchNodeSite(url: URL, init: RequestInit): Promise<Response> {
  return present(Effect.callback<Response, Error>((resume) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method, headers, signal: init.signal ?? undefined,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      }
      const status = incoming.statusCode ?? 502;
      const empty = init.method === "HEAD" || [204, 205, 304].includes(status);
      if (empty) incoming.resume();
      resume(Effect.succeed(new Response(empty ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status, headers: responseHeaders,
      })));
    });
    request.once("error", (error) => resume(Effect.fail(error)));
    request.end(init.body);
  }));
}
