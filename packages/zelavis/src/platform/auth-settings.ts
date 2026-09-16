import { resolveLocalPackageManifest } from "../adapters/_local-runtime.js";
import { loadPluginPackage } from "../service.js";

/**
 * Loads the auth settings page through the ordinary plugin loader.
 *
 * The page is a product service, not part of auth. Accounts, sessions,
 * credentials and the OAuth flow are Zelavis itself — an installation cannot
 * run without them — but the page that configures them is something a package
 * can own, and removing it costs a settings screen rather than the ability to
 * sign in.
 *
 * Loaded the way an installed third-party service is, so its menu reaches the
 * dashboard through the same extension path any plugin uses. If that path
 * breaks, the Platform's own settings page breaks with it, which is the only
 * way a first-party service tests a public contract.
 */
export function createZelavisAuthSettingsService() {
  const manifest = resolveLocalPackageManifest("@zelavis/auth");
  if (!manifest) {
    throw new Error("Unable to resolve package manifest for @zelavis/auth");
  }

  return loadPluginPackage({
    manifest,
    // Resolve at runtime so the SDK bootstrap does not require this package's
    // declarations before the product-service build has emitted them.
    importer: () => import(manifest.name),
    packageDir: manifest.packageDir,
  });
}
