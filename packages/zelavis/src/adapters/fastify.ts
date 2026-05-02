import type { FastifyPluginAsync } from "fastify";
import { fastifyAdapter as bindFastifyRuntime } from "@zelavis/server/adapters/fastify";
import type { ZelavisAdapterBinding } from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

export interface ZelavisFastifyBinding extends ZelavisAdapterBinding {
  fastifyPlugin(): FastifyPluginAsync;
}

export function fastifyAdapter() {
  return createRuntimeBackedAdapter<ZelavisFastifyBinding>(
    "fastify",
    ({ getRuntime }) => {
      const getPlugin = createLazyBoundValue(async () =>
        bindFastifyRuntime(await getRuntime()),
      );

      return {
        async ready() {
          await getPlugin();
        },
        fastifyPlugin() {
          return async (fastify, options) => {
            const plugin = await getPlugin();
            return plugin(fastify, options);
          };
        },
      };
    },
  );
}
