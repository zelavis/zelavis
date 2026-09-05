import { loadPluginPackage } from "../../dist/service.js";
import { ECOMMERCE_MANIFEST } from "../../../../plugins/ecommerce/dist/manifest.js";

/**
 * Loads the ecommerce plugin the way an installation does.
 *
 * The plugin declares its menu through `zelavis.menu.create`, which only works
 * inside a plugin execution context — so importing the module and passing the
 * object into a catalogue no longer works, and these tests exercise the real
 * install path instead of a shape only tests used.
 *
 * Loaded once and reused: the SDK contributes menus by side effect during
 * module evaluation, and a module evaluates only on its first import, so a
 * second load would produce a plugin with no menus at all.
 */
let cached;

export function loadEcommercePlugin() {
  cached ??= loadPluginPackage({
    manifest: ECOMMERCE_MANIFEST,
    importer: () => import("../../../../plugins/ecommerce/dist/index.js"),
  });
  return cached;
}
