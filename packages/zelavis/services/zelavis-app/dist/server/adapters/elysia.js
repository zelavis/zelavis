import { Elysia } from "elysia";
import { createRequestFromPlainInput, toResponseHeaderEntries, } from "../core/request-dispatcher.js";
function splitSegments(path) {
    return path.split("/").filter(Boolean);
}
function getMountPrefix(routes) {
    if (routes.length === 0) {
        return "/";
    }
    const [first, ...rest] = routes.map((route) => splitSegments(route.fullPath));
    const prefix = [];
    for (let index = 0; index < first.length; index += 1) {
        const segment = first[index];
        if (!rest.every((path) => path[index] === segment)) {
            break;
        }
        prefix.push(segment);
    }
    return prefix.length === 0 ? "/" : `/${prefix.join("/")}`;
}
function toHeadSafeResponse(method, response) {
    if (method.toUpperCase() !== "HEAD") {
        return response;
    }
    return new Response(null, {
        status: response.status,
        headers: toResponseHeaderEntries(response.headers),
    });
}
export function elysiaAdapter(runtime) {
    const prefix = getMountPrefix(runtime.routes);
    const plugin = new Elysia({
        name: `zelavis${prefix === "/" ? "" : prefix}`,
        prefix,
    });
    const handleRequest = async (context) => {
        const webRequest = createRequestFromPlainInput({
            url: context.request.url,
            method: context.request.method,
            headers: context.request.headers,
            body: context.body,
            baseUrl: new URL(context.request.url).origin,
        });
        const result = await runtime.dispatch(webRequest, {
            platform: {
                elysia: context,
            },
        });
        return toHeadSafeResponse(context.request.method, result.response);
    };
    return plugin.all("/", handleRequest).all("/*", handleRequest);
}
