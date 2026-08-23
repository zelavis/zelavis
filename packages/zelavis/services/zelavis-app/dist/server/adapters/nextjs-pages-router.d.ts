import type { NextApiHandler } from "next";
import type { ZelavisServerRuntime } from "../contracts.js";
type MaybePromise<T> = T | Promise<T>;
export interface NextjsPagesRouterAdapterOptions {
    routePrefix?: string;
    mountPath?: string;
}
export declare function nextjsPagesRouterAdapter<TService = unknown>(runtime: MaybePromise<Pick<ZelavisServerRuntime<TService>, "fetch">>, options?: NextjsPagesRouterAdapterOptions): NextApiHandler;
export {};
