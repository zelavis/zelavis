import { Readable } from "node:stream";
import { createRequestFromPlainInput, toResponseHeaderEntries, } from "../core/request-dispatcher.js";
function canHaveBody(method) {
    return method !== "GET" && method !== "HEAD";
}
function firstHeaderValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}
function getRequestProtocol(request) {
    const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"])
        ?.split(",")[0]
        ?.trim();
    if (forwardedProtocol) {
        return forwardedProtocol;
    }
    return request.socket.encrypted
        ? "https"
        : "http";
}
function toBodyInit(body) {
    if (body == null) {
        return undefined;
    }
    if (typeof body === "string" ||
        body instanceof URLSearchParams ||
        body instanceof FormData ||
        body instanceof Blob ||
        body instanceof ReadableStream) {
        return body;
    }
    if (body instanceof ArrayBuffer) {
        return new Uint8Array(body);
    }
    if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (typeof body === "object") {
        return JSON.stringify(body);
    }
    return String(body);
}
export async function toNodeLikeWebRequest(request, options = {}) {
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
            ? Readable.toWeb(request)
            : toBodyInit(request.body)
        : undefined;
    return createRequestFromPlainInput({
        url: options.url ?? request.url ?? "/",
        method,
        headers,
        body,
        baseUrl: options.baseUrl ??
            `${getRequestProtocol(request)}://${request.headers.host ?? "localhost"}`,
    });
}
export async function sendNodeLikeResponse(response, payload, method = "GET") {
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
    await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(payload.body);
        stream.on("error", reject);
        response.on("error", reject);
        response.on("finish", resolve);
        stream.pipe(response);
    });
}
