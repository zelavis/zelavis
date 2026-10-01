import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ZelavisPlatformFrontendFactory } from "../index.js";

/** Where an installation resolves the dashboard from when nothing ships it beside the Platform. */
const DASHBOARD_PACKAGE = "@zelavis/ui/frontend";

export interface ResolveBundledFrontendOptions {
  /** The directory of a default service shipped inside this package, by name. */
  readonly bundledDirectory: (packageName: string) => string | undefined;
  /** Imports a module. The specifier is held in a variable so TypeScript never resolves it. */
  readonly importer?: (specifier: string) => Promise<unknown>;
}

const factoryOf = (loaded: unknown): ZelavisPlatformFrontendFactory | undefined => {
  const candidate = (loaded as { zelavisUiFrontend?: unknown } | undefined)?.zelavisUiFrontend;
  return typeof candidate === "function" ? (candidate as ZelavisPlatformFrontendFactory) : undefined;
};

/**
 * The dashboard a Platform serves.
 *
 * It is one of the default services shipped in this package's `services/`
 * folder, so that is where it comes from first: the version that was released
 * with this Platform, with nothing for an installer to add beside it. Only when
 * that folder has no dashboard (a build without it) does an installed
 * `@zelavis/ui` stand in. Without either, the Platform serves its placeholder.
 */
export async function resolveBundledFrontend(
  options: ResolveBundledFrontendOptions,
): Promise<ZelavisPlatformFrontendFactory | undefined> {
  const load = options.importer ?? ((specifier: string) => import(specifier));

  const directory = options.bundledDirectory("@zelavis/ui");
  const entry = directory ? join(directory, "dist", "frontend.js") : undefined;
  if (entry && existsSync(entry)) {
    try {
      const shipped = factoryOf(await load(pathToFileURL(entry).href));
      if (shipped) return shipped;
    } catch {
      // Fall through to an installed package.
    }
  }

  try {
    return factoryOf(await load(DASHBOARD_PACKAGE));
  } catch {
    return undefined;
  }
}
