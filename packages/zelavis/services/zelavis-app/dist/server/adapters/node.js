import { createServer } from "node:http";
import { sendNodeLikeResponse, toNodeLikeWebRequest } from "./node-shared.js";
export function nodeAdapter(runtime) {
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
