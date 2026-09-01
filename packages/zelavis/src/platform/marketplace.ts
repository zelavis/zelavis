import { MARKETPLACE_MANIFEST } from "@zelavis/marketplace/manifest";

import { loadPluginPackage } from "../service.js";

/**
 * Loads the marketplace through the same plugin loader an installed
 * third-party service goes through.
 *
 * This is the point of shipping the marketplace as its own package. The module
 * body runs inside a plugin execution context, so its `zelavis.menu.create`
 * calls are the real SDK calls and its menus reach the dashboard through the
 * ordinary extension path. If that path is broken, the Platform's own
 * marketplace is broken with it — which is the only way a first-party service
 * is a real test of a public contract.
 *
 * The loading lives here rather than in the marketplace package because the
 * marketplace compiles first: it may depend on `zelavis/sdk` and nothing else,
 * or the two packages cannot both be built from a clean checkout.
 */
export function createZelavisMarketplaceService() {
  // Loaded exactly once, and the resolved service reused.
  //
  // The SDK contributes menus by side effect during module evaluation, and a
  // module evaluates only on its first import. Loading twice in one process —
  // two Platform runtimes, or a test composing a second one — would run the
  // loader against an already-evaluated module and produce a marketplace with
  // no menus at all. Memoizing is also the honest model: these are static
  // declarations about what the service is, not per-runtime state, and the
  // service `loadPluginPackage` returns is frozen.
  cached ??= loadPluginPackage({
    manifest: MARKETPLACE_MANIFEST,
    importer: () => import("@zelavis/marketplace"),
  });
  return cached;
}

let cached: ReturnType<typeof loadPluginPackage> | undefined;
