import { loadPluginPackage } from "../../../packages/zelavis/dist/service.js";
import { ECOMMERCE_MANIFEST } from "../dist/manifest.js";

/**
 * Loads the plugin the way an installation does.
 *
 * It declares its menu through `zelavis.menu.create`, which only works inside
 * a plugin execution context — so importing the module and passing the object
 * into a catalogue no longer works, and these tests exercise the real install
 * path rather than a shape only tests used.
 *
 * Loaded once and reused: the SDK contributes menus by side effect during
 * module evaluation, and a module evaluates only on its first import, so a
 * second load would produce a plugin with no menus at all.
 */
let cached;

export function loadEcommercePlugin() {
  cached ??= loadPluginPackage({
    manifest: ECOMMERCE_MANIFEST,
    importer: () => import("../dist/index.js"),
  });
  return cached;
}
