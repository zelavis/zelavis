import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePluginRegistry,
  applyPluginRegistryState,
  createPlugin,
  createPluginRegistry,
  defineServerService,
  loadPlugin,
  loadPluginRegistry,
  removePluginFromRegistry,
  resolvePluginModule,
  serializePluginRegistryState,
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
    /path must be a string/,
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

test("createPlugin allows nested menu groups without a fake path", () => {
  const plugin = createPlugin({
    name: "zelavis-ecommerce",
    menu: {
      title: "Ecommerce",
      path: "/commerce",
      items: [
        {
          title: "More",
          items: [
            {
              title: "Customers",
              path: "/commerce/customers",
            },
          ],
        },
      ],
    },
  });

  assert.equal(plugin.menu.items[0].title, "More");
  assert.equal(plugin.menu.items[0].path, undefined);
});

test("resolvePluginModule accepts named or default ESM exports", () => {
  const named = resolvePluginModule({
    plugin: {
      name: "named-plugin",
      menu: {
        title: "Named",
        path: "/named",
      },
    },
  });
  const byDefault = resolvePluginModule({
    default: {
      name: "default-plugin",
      menu: {
        title: "Default",
        path: "/default",
      },
    },
  });

  assert.equal(named.name, "named-plugin");
  assert.equal(byDefault.name, "default-plugin");
});

test("loadPlugin uses the provided ESM importer", async () => {
  const plugin = await loadPlugin("virtual:ecommerce", {
    importer: async (specifier) => ({
      plugin: {
        name: specifier.replace("virtual:", "zelavis-"),
        menu: {
          title: "Ecommerce",
          path: "/commerce",
        },
      },
    }),
  });

  assert.equal(plugin.name, "zelavis-ecommerce");
  assert.equal(plugin.menu.path, "/commerce");
});

test("loadPluginRegistry normalizes imported plugin modules", async () => {
  const registry = await loadPluginRegistry(
    [
      {
        specifier: "virtual:ecommerce",
        source: "official",
      },
      {
        specifier: "virtual:analytics",
        status: "available",
        source: "community",
      },
    ],
    {
      importer: async (specifier) => ({
        default: {
          name: specifier.replace("virtual:", "zelavis-"),
          menu: {
            title: specifier.endsWith("ecommerce") ? "Ecommerce" : "Analytics",
            path: specifier.endsWith("ecommerce")
              ? "/commerce"
              : "/analytics",
          },
        },
      }),
    },
  );

  assert.equal(registry.length, 2);
  assert.equal(registry[0].status, "installed");
  assert.equal(registry[1].status, "available");
  assert.equal(registry[1].plugin.name, "zelavis-analytics");
});

test("removePluginFromRegistry removes entries without mutating the original registry", () => {
  const registry = createPluginRegistry([
    {
      plugin: {
        name: "zelavis-ecommerce",
        menu: {
          title: "Ecommerce",
          path: "/commerce",
        },
      },
      status: "installed",
      source: "official",
    },
    {
      plugin: {
        name: "zelavis-analytics",
        menu: {
          title: "Analytics",
          path: "/analytics",
        },
      },
      status: "available",
      source: "community",
    },
  ]);

  const nextRegistry = removePluginFromRegistry(registry, "zelavis-ecommerce");

  assert.equal(registry.length, 2);
  assert.equal(nextRegistry.length, 1);
  assert.equal(nextRegistry[0].plugin.name, "zelavis-analytics");
});

test("applyPluginRegistryState overlays stored install state and order", () => {
  const registry = createPluginRegistry([
    {
      plugin: {
        name: "zelavis-ecommerce",
      },
      status: "available",
      source: "official",
    },
    {
      plugin: {
        name: "zelavis-analytics",
      },
      status: "available",
      source: "community",
    },
  ]);

  const nextRegistry = applyPluginRegistryState(registry, [
    {
      name: "zelavis-analytics",
      status: "installed",
      order: 1,
    },
    {
      name: "zelavis-ecommerce",
      status: "installed",
      order: 0,
    },
  ]);

  assert.equal(nextRegistry[0].status, "installed");
  assert.equal(nextRegistry[0].order, 0);
  assert.equal(nextRegistry[1].status, "installed");
  assert.deepEqual(serializePluginRegistryState(nextRegistry), [
    {
      name: "zelavis-ecommerce",
      status: "installed",
      source: "official",
      order: 0,
    },
    {
      name: "zelavis-analytics",
      status: "installed",
      source: "community",
      order: 1,
    },
  ]);
});

test("activatePluginRegistry runs installed plugins in order and collects services", async () => {
  const activationOrder = [];
  const firstService = defineServerService({
    name: "first-plugin-service",
    service: {},
    api: { v1: [] },
  });
  const secondService = defineServerService({
    name: "second-plugin-service",
    service: {},
    api: { v1: [] },
  });

  const registry = createPluginRegistry([
    {
      plugin: createPlugin({
        name: "second",
        setup(context) {
          activationOrder.push(context.plugin.name);
          context.addService(secondService);
        },
      }),
      status: "installed",
      order: 2,
    },
    {
      plugin: createPlugin({
        name: "first",
        services: [firstService],
        setup(context) {
          activationOrder.push(context.plugin.name);
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      plugin: createPlugin({
        name: "available-only",
      }),
      status: "available",
    },
  ]);

  const activated = await activatePluginRegistry(registry, {
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    platform: {
      presets: ["node"],
      resources: {
        keyValueStore: false,
        fileStorage: true,
      },
      metadata: {
        runtime: "test",
      },
    },
  });

  assert.deepEqual(activationOrder, ["first", "second"]);
  assert.deepEqual(
    activated.services.map((service) => service.name),
    ["first-plugin-service", "second-plugin-service"],
  );
});

test("activatePluginRegistry exposes standard platform context to plugin setup", async () => {
  let seenPlatform;

  const registry = createPluginRegistry([
    {
      plugin: createPlugin({
        name: "platform-aware",
        setup(context) {
          seenPlatform = context.platform;
        },
      }),
      status: "installed",
      order: 0,
    },
  ]);

  await activatePluginRegistry(registry, {
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    platform: {
      presets: ["cloudflare", "d1"],
      resources: {
        keyValueStore: true,
        fileStorage: false,
      },
      metadata: {
        deployment: "edge",
      },
    },
  });

  assert.deepEqual(seenPlatform, {
    presets: ["cloudflare", "d1"],
    resources: {
      keyValueStore: true,
      fileStorage: false,
    },
    metadata: {
      deployment: "edge",
    },
  });
});
