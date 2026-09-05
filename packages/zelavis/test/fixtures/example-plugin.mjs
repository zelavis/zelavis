import { loadPluginPackage } from "../../dist/service.js";

/**
 * A plugin with everything core needs to test plugin handling.
 *
 * Core used to reach for `@zelavis/ecommerce` here — a real product plugin —
 * which meant core could not run its own tests without building one, and a
 * change to a shopping cart could fail the Platform's suite. This has the same
 * shape and belongs to nobody: a menu with a page, page assets it ships
 * itself, capabilities, and a `setup` that registers a second service the way
 * a real plugin does.
 */
export const EXAMPLE_PLUGIN_MANIFEST = Object.freeze({
  name: "@example/catalog",
  version: "1.0.0",
  type: "module",
  exports: Object.freeze({
    ".": Object.freeze({ import: "./dist/index.js" }),
  }),
  zelavis: Object.freeze({
    kind: "plugin",
    capabilities: Object.freeze(["api:routes", "dashboard:menu"]),
  }),
});

const service = Object.freeze({
  name: "@example/catalog",
  version: "1.0.0",
  kind: "plugin",
  capabilities: Object.freeze(["api:routes", "dashboard:menu"]),
  menu: Object.freeze({
    title: "Catalog",
    path: "/catalog",
    pageLabel: "Catalog",
    page: Object.freeze({
      id: "catalog",
      title: "Catalog",
      file: "catalog.html",
    }),
    items: Object.freeze([
      Object.freeze({
        title: "Items",
        path: "/catalog/items",
        page: Object.freeze({ id: "items", title: "Items", file: "items.html" }),
      }),
    ]),
  }),
  pageAssets: Object.freeze({
    "catalog.html": Object.freeze({
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Catalog</title><main>Catalog workspace</main>",
    }),
    "items.html": Object.freeze({
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><title>Items</title><main>Items</main>",
    }),
  }),
  // Registered during setup, the way a plugin that owns an API surface does.
  // The health route reports the setup context back, which is what makes this
  // a useful fixture: it proves a plugin is handed the platform presets and
  // resources rather than only that it mounted.
  setup(context) {
    context.addService({
      name: "catalog",
      basePath: "/catalog",
      service: {},
      api: {
        v1: [
          {
            id: "catalog.health",
            method: "GET",
            path: "/health",
            handler: async () => ({
              status: 200,
              body: {
                service: "@example/catalog",
                platform: {
                  presets: context.platform.presets,
                  resources: context.platform.resources,
                },
                database: Boolean(context.core?.database),
              },
            }),
          },
        ],
      },
    });
  },
});

let cached;

/** Loads the fixture the way an installation loads a plugin. */
export function loadExamplePlugin() {
  cached ??= loadPluginPackage({
    manifest: EXAMPLE_PLUGIN_MANIFEST,
    importer: async () => ({ default: service }),
  });
  return cached;
}
