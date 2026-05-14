import type { NextApiHandler } from "next";
import {
  nextjsPagesRouterAdapter as bindNextjsPagesRouterRuntime,
  type NextjsPagesRouterAdapterOptions,
} from "@zelavis/server/adapters/nextjs-pages-router";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";

export type { NextjsPagesRouterAdapterOptions };

export interface ZelavisNextjsPagesRouterAdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisNextjsPagesRouterBinding extends ZelavisAdapterBinding {
  nextjsPagesRouterHandler(
    options?: NextjsPagesRouterAdapterOptions,
  ): NextApiHandler;
}

export function nextjsPagesRouterAdapter(
  options: ZelavisNextjsPagesRouterAdapterOptions = {},
) {
  return defineAdapter<ZelavisNextjsPagesRouterBinding>({
    name: "nextjs-pages-router",
    platform: options.platform,
    mount: ({ getRuntime }) => ({
      async ready() {
        await getRuntime();
      },
      nextjsPagesRouterHandler(
        handlerOptions: NextjsPagesRouterAdapterOptions = {},
      ) {
        return bindNextjsPagesRouterRuntime(getRuntime(), handlerOptions);
      },
    }),
  });
}
