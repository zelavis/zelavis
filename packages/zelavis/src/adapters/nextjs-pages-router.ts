import type { NextApiHandler } from "next";
import {
  nextjsPagesRouterAdapter as bindNextjsPagesRouterRuntime,
  type NextjsPagesRouterAdapterOptions,
} from "@zelavis/server/adapters/nextjs-pages-router";
import type { ZelavisAdapterBinding } from "../index.js";
import { createRuntimeBackedAdapter } from "./_shared.js";

export type { NextjsPagesRouterAdapterOptions };

export interface ZelavisNextjsPagesRouterBinding extends ZelavisAdapterBinding {
  nextjsPagesRouterHandler(
    options?: NextjsPagesRouterAdapterOptions,
  ): NextApiHandler;
}

export function nextjsPagesRouterAdapter() {
  return createRuntimeBackedAdapter<ZelavisNextjsPagesRouterBinding>(
    "nextjs-pages-router",
    ({ getRuntime }) => ({
      async ready() {
        await getRuntime();
      },
      nextjsPagesRouterHandler(
        options: NextjsPagesRouterAdapterOptions = {},
      ) {
        return bindNextjsPagesRouterRuntime(getRuntime(), options);
      },
    }),
  );
}
