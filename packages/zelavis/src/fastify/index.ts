import type { FastifyPluginAsync } from "fastify";
import { fastifyAdapter as bindFastifyRuntime } from "@zelavis/server/adapters/fastify";
import type { Zelavis } from "../index.js";

export function fastifyPlugin(zelavis: Zelavis): FastifyPluginAsync {
  return async (instance, options) => {
    const runtime = await zelavis.runtime();
    const plugin = bindFastifyRuntime(runtime);
    return plugin(instance, options);
  };
}
