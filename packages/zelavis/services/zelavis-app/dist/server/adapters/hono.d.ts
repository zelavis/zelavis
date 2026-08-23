import type { MiddlewareHandler } from "hono";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function honoAdapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">): MiddlewareHandler;
