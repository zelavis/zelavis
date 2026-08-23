import { Elysia } from "elysia";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function elysiaAdapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "dispatch" | "routes">): Elysia<string, {
    decorator: {};
    store: {};
    derive: {};
    resolve: {};
}, {
    typebox: {};
    error: {};
}, {
    schema: {};
    standaloneSchema: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {
    [x: string]: {
        [x: string]: {
            body: unknown;
            params: {};
            query: unknown;
            headers: unknown;
            response: {
                200: Response;
            };
        };
    };
} & {
    [x: string]: {
        "*": {
            [x: string]: {
                body: unknown;
                params: {
                    "*": string;
                } & {};
                query: unknown;
                headers: unknown;
                response: {
                    200: Response;
                    422: {
                        type: "validation";
                        on: string;
                        summary?: string;
                        message?: string;
                        found?: unknown;
                        property?: string;
                        expected?: string;
                    };
                };
            };
        };
    };
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}, {
    derive: {};
    resolve: {};
    schema: {};
    standaloneSchema: {};
    response: {};
}>;
