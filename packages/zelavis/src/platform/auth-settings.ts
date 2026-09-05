import { AUTH_SETTINGS_MANIFEST } from "@zelavis/auth/manifest";

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
  // Loaded once and reused: the SDK contributes menus by side effect during
  // module evaluation, and a module evaluates only on its first import, so a
  // second load would produce a service with no menus at all.
  cached ??= loadPluginPackage({
    manifest: AUTH_SETTINGS_MANIFEST,
    importer: () => import("@zelavis/auth"),
  });
  return cached;
}

let cached: ReturnType<typeof loadPluginPackage> | undefined;
