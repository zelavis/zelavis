import type { RequestHandler } from "express";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function expressAdapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">): RequestHandler;
