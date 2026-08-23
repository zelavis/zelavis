import type { FastifyPluginAsync } from "fastify";
import type { ZelavisServerRuntime } from "../contracts.js";
export declare function fastifyAdapter<TService = unknown>(runtime: Pick<ZelavisServerRuntime<TService>, "dispatch">): FastifyPluginAsync;
