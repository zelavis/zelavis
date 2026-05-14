import type { NextApiHandler } from "next";
import {
  nextjsPagesRouterAdapter as bindNextjsPagesRouterRuntime,
  type NextjsPagesRouterAdapterOptions,
} from "@zelavis/server/adapters/nextjs-pages-router";
import type { Zelavis } from "../../index.js";

export type { NextjsPagesRouterAdapterOptions };

export function nextjsPagesRouterHandler(
  zelavis: Zelavis,
  options: NextjsPagesRouterAdapterOptions = {},
): NextApiHandler {
  return bindNextjsPagesRouterRuntime(zelavis.runtime(), options);
}
