import type { FastifyPluginAsync } from "fastify";
import { fastifyAdapter as bindFastifyRuntime } from "@zelavis/server/adapters/fastify";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";
import { createLazyBoundValue } from "./_shared.js";

export interface ZelavisFastifyAdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisFastifyBinding extends ZelavisAdapterBinding {
  fastifyPlugin(): FastifyPluginAsync;
}

export function fastifyAdapter(options: ZelavisFastifyAdapterOptions = {}) {
  return defineAdapter<ZelavisFastifyBinding>({
    name: "fastify",
    platform: options.platform,
    mount: ({ getRuntime }) => {
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
  });
}
