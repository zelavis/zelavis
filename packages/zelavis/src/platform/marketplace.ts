import { resolveLocalPackageManifest } from "../adapters/_local-runtime.js";
import { loadPluginPackage } from "../service.js";

/**
 * Loads the marketplace through the same plugin loader an installed
 * third-party service goes through.
 *
 * This is the point of shipping the marketplace as its own package. Its register hook
 * runs inside a fresh plugin execution context, so its `zelavis.plugins.ui.menus.create`
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
  const manifest = resolveLocalPackageManifest("@zelavis/marketplace");
  if (!manifest) {
    throw new Error("Unable to resolve package manifest for @zelavis/marketplace");
  }

  return loadPluginPackage({
    manifest,
    // Resolve at runtime so the SDK bootstrap does not require this package's
    // declarations before the product-service build has emitted them.
    importer: () => import(manifest.name),
    packageDir: manifest.packageDir,
  });
}
