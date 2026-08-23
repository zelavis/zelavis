import type { Server } from "node:http";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function nodeAdapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "fetch">): Server;
