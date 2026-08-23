import type { IncomingMessage, ServerResponse } from "node:http";
interface NodeLikeRequest extends IncomingMessage {
    body?: unknown;
}
interface ToNodeLikeWebRequestOptions {
    url?: string;
    baseUrl?: string;
}
export declare function toNodeLikeWebRequest(request: NodeLikeRequest, options?: ToNodeLikeWebRequestOptions): Promise<Request>;
export declare function sendNodeLikeResponse(response: ServerResponse, payload: Response, method?: string): Promise<void>;
export {};
