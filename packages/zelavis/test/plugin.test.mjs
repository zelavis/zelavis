import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlugin,
  createPluginRegistry,
  defineServerService,
} from "../dist/index.js";

test("createPlugin normalizes plugin metadata for developer-facing extensions", () => {
  const service = defineServerService({
    name: "commerce",
    service: {},
    api: {
      v1: [],
    },
  });

  const plugin = createPlugin({
    name: "zelavis-ecommerce",
    version: "1.0.0",
    menu: {
      title: "Ecommerce",
      path: "/commerce",
      pageLabel: "Commerce",
    },
    services: [service],
  });

  assert.equal(plugin.name, "zelavis-ecommerce");
  assert.equal(plugin.menu.title, "Ecommerce");
  assert.equal(plugin.menu.path, "/commerce");
  assert.equal(plugin.services.length, 1);
  assert.ok(Object.isFrozen(plugin));
  assert.ok(Object.isFrozen(plugin.menu));
  assert.ok(Object.isFrozen(plugin.services));
});

test("createPlugin validates required plugin fields", () => {
  assert.throws(
    () =>
      createPlugin({
        name: "",
      }),
    /string name/,
  );

  assert.throws(
    () =>
      createPlugin({
        name: "broken-plugin",
        menu: {
          title: "Broken",
          path: 123,
        },
      }),
    /string path/,
  );
});

test("createPluginRegistry normalizes plugin registry entries", () => {
  const registry = createPluginRegistry([
    {
      plugin: {
        name: "zelavis-ecommerce",
        menu: {
          title: "Ecommerce",
          path: "/commerce",
          items: [
            {
              title: "Orders",
              path: "/commerce/orders",
            },
          ],
        },
      },
      status: "installed",
      source: "official",
    },
  ]);

  assert.equal(registry.length, 1);
  assert.equal(registry[0].plugin.menu.items[0].title, "Orders");
  assert.ok(Object.isFrozen(registry));
});
