import { loadPluginPackage } from "zelavis";

import { MARKETPLACE_MANIFEST } from "./manifest.js";

/**
 * Loads the marketplace through the same plugin loader an installed
 * third-party service goes through.
 *
 * This is the point of shipping the marketplace this way. The module body runs
 * inside a plugin execution context, so its `zelavis.menu.create` calls are the
 * real SDK calls, and its menus reach the dashboard through the ordinary
 * extension path. If that path is broken, the Platform's own marketplace is
 * broken with it — which is the only way a first-party service is a real test
 * of a public contract.
 *
 * The importer is a static import rather than a specifier: a service that
 * ships inside the Platform has no install step, so there is nothing on disk
 * to resolve.
 */
export function createZelavisMarketplaceService() {
  // Loaded exactly once, and the resolved service reused.
  //
  // The SDK contributes menus by side effect during module evaluation, and a
  // statically imported module evaluates only on its first import. Loading
  // twice in one process — two Platform runtimes, or a test composing a second
  // one — would run the loader against an already-evaluated module and produce
  // a marketplace with no menus at all. Memoizing is also the honest model:
  // these are static declarations about what the service is, not per-runtime
  // state, and the service `loadPluginPackage` returns is frozen.
  cached ??= loadPluginPackage({
    manifest: MARKETPLACE_MANIFEST,
    importer: () => import("./index.js"),
  });
  return cached;
}

let cached: ReturnType<typeof loadPluginPackage> | undefined;
