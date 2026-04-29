import { createServer } from "node:http";
import type { Server } from "node:http";
import type { ZelavisServerRuntime } from "../contracts.js";
import { sendNodeLikeResponse, toNodeLikeWebRequest } from "./node-shared.js";

export function nodeIntegration<TService = unknown>(
  runtime: Pick<ZelavisServerRuntime<TService>, "fetch">,
): Server {
  return createServer(async (request, response) => {
    const webRequest = await toNodeLikeWebRequest(request);
    const webResponse = await runtime.fetch(webRequest, {
      platform: {
        node: {
          request,
          response,
        },
      },
    });

    await sendNodeLikeResponse(response, webResponse, request.method ?? "GET");
  });
}
