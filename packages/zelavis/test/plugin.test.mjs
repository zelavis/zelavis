import assert from "node:assert/strict";
import test from "node:test";
import {
  activatePluginRegistry,
  applyPluginRegistryState,
  definePlugin,
  createPluginRegistry,
  defineService,
  loadPlugin,
  loadPluginRegistry,
  removePluginFromRegistry,
  resolvePluginModule,
  serializePluginRegistryState,
  isPluginExtensionAllowed,
  ZELAVIS_PLUGIN_V1,
} from "../dist/index.js";

test("definePlugin normalizes plugin metadata for developer-facing extensions", () => {
  const service = defineService({
    name: "commerce",
    service: {},
    api: {
      v1: [],
    },
  });

  const plugin = definePlugin({
    name: "zelavis-ecommerce",
    version: "1.0.0",
    extensionPoints: [
      {
        name: "payments",
        policy: "reviewed",
        allowedPlugins: ["stripe"],
      },
    ],
    menu: {
      title: "Ecommerce",
      path: "/commerce",
      pageLabel: "Commerce",
    },
    services: [service],
  });

  assert.equal(plugin.name, "zelavis-ecommerce");
  assert.equal(plugin.contractVersion, ZELAVIS_PLUGIN_V1);
  assert.equal(plugin.menu.title, "Ecommerce");
  assert.equal(plugin.menu.path, "/commerce");
  assert.equal(plugin.extensionPoints[0].name, "payments");
  assert.equal(plugin.extensionPoints[0].policy, "reviewed");
  assert.deepEqual(plugin.extensionPoints[0].allowedPlugins, ["stripe"]);
  assert.equal(plugin.services.length, 1);
  assert.ok(Object.isFrozen(plugin));
  assert.ok(Object.isFrozen(plugin.menu));
  assert.ok(Object.isFrozen(plugin.services));
  assert.ok(Object.isFrozen(plugin.extensionPoints));
  assert.ok(Object.isFrozen(plugin.extensionPoints[0].allowedPlugins));
});

test("definePlugin validates required plugin fields", () => {
  assert.throws(
    () =>
      definePlugin({
        name: "",
      }),
    /string name/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "broken-plugin",
        menu: {
          title: "Broken",
          path: 123,
        },
      }),
    /path must be a string/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "future-plugin",
        contractVersion: "ZELAVIS_PLUGIN_V2",
      }),
    /Unsupported plugin contract version/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "surface-plugin",
        menu: {
          title: "Surface",
          path: "/surface",
          surface: "root",
        },
      }),
    /cannot declare a dashboard surface/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "stripe",
        extends: {
          plugin: "",
          extensionPoint: "payments",
        },
      }),
    /parent plugin name/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "stripe",
        extends: {
          plugin: "zelavis-ecommerce",
          extensionPoint: "payments",
        },
        menu: {
          title: "Stripe",
          path: "/stripe",
        },
      }),
    /Child plugins cannot declare top-level dashboard menu metadata/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "zelavis-ecommerce",
        extensionPoints: [
          {
            name: "payments",
            policy: "chaos",
          },
        ],
      }),
    /policy must be "open", "reviewed", or "private"/,
  );

  assert.throws(
    () =>
      definePlugin({
        name: "zelavis-ecommerce",
        extensionPoints: [
          {
            name: "payments",
          },
          {
            name: "payments",
          },
        ],
      }),
    /unique names/,
  );
});

test("definePlugin supports child plugin extension metadata", () => {
  const plugin = definePlugin({
    name: "stripe",
    extends: {
      plugin: "zelavis-ecommerce",
      extensionPoint: "payments",
    },
  });

  assert.equal(plugin.extends.plugin, "zelavis-ecommerce");
  assert.equal(plugin.extends.extensionPoint, "payments");
  assert.ok(Object.isFrozen(plugin.extends));
});

test("isPluginExtensionAllowed applies parent extension point policies", () => {
  const parent = {
    plugin: definePlugin({
      name: "zelavis-ecommerce",
      extensionPoints: [
        {
          name: "payments",
          policy: "reviewed",
          allowedPlugins: ["stripe"],
        },
        {
          name: "shipping",
          policy: "open",
        },
      ],
    }),
    status: "installed",
  };
  const stripe = {
    plugin: definePlugin({
      name: "stripe",
      extends: {
        plugin: "zelavis-ecommerce",
        extensionPoint: "payments",
      },
    }),
    status: "installed",
  };
  const xyz = {
    plugin: definePlugin({
      name: "xyz-payments",
      extends: {
        plugin: "zelavis-ecommerce",
        extensionPoint: "payments",
      },
    }),
    status: "installed",
  };
  const shipping = {
    plugin: definePlugin({
      name: "ship-fast",
      extends: {
        plugin: "zelavis-ecommerce",
        extensionPoint: "shipping",
      },
    }),
    status: "installed",
  };

  assert.equal(isPluginExtensionAllowed(parent, stripe), true);
  assert.equal(isPluginExtensionAllowed(parent, xyz), false);
  assert.equal(isPluginExtensionAllowed(parent, shipping), true);
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

test("definePlugin allows nested menu groups without a fake path", () => {
  const plugin = definePlugin({
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
  const firstService = defineService({
    name: "first-plugin-service",
    service: {},
    api: { v1: [] },
  });
  const secondService = defineService({
    name: "second-plugin-service",
    service: {},
    api: { v1: [] },
  });

  const registry = createPluginRegistry([
    {
      plugin: definePlugin({
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
      plugin: definePlugin({
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
      plugin: definePlugin({
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
    core: {},
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

test("activatePluginRegistry gives child plugins to their parent without activating them directly", async () => {
  const activationOrder = [];
  let seenChildren = [];

  const registry = createPluginRegistry([
    {
      plugin: definePlugin({
        name: "stripe",
        extends: {
          plugin: "zelavis-ecommerce",
          extensionPoint: "payments",
        },
        setup() {
          activationOrder.push("stripe");
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      plugin: definePlugin({
        name: "zelavis-ecommerce",
        extensionPoints: [
          {
            name: "payments",
            policy: "reviewed",
            allowedPlugins: ["stripe"],
          },
        ],
        setup(context) {
          activationOrder.push("zelavis-ecommerce");
          seenChildren = context.children;
        },
      }),
      status: "installed",
      order: 1,
    },
  ]);

  await activatePluginRegistry(registry, {
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    core: {},
    platform: {
      presets: [],
      resources: {
        keyValueStore: false,
        fileStorage: false,
      },
      metadata: {},
    },
  });

  assert.deepEqual(activationOrder, ["zelavis-ecommerce"]);
  assert.equal(seenChildren.length, 1);
  assert.equal(seenChildren[0].name, "stripe");
  assert.equal(seenChildren[0].extends.extensionPoint, "payments");
});

test("activatePluginRegistry withholds child plugins rejected by parent policy", async () => {
  let seenChildren = [];

  const registry = createPluginRegistry([
    {
      plugin: definePlugin({
        name: "xyz-payments",
        extends: {
          plugin: "zelavis-ecommerce",
          extensionPoint: "payments",
        },
        setup() {
          throw new Error("Rejected child plugins should not activate.");
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      plugin: definePlugin({
        name: "zelavis-ecommerce",
        extensionPoints: [
          {
            name: "payments",
            policy: "reviewed",
            allowedPlugins: ["stripe"],
          },
        ],
        setup(context) {
          seenChildren = context.children;
        },
      }),
      status: "installed",
      order: 1,
    },
  ]);

  await activatePluginRegistry(registry, {
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    core: {},
    platform: {
      presets: [],
      resources: {
        keyValueStore: false,
        fileStorage: false,
      },
      metadata: {},
    },
  });

  assert.deepEqual(seenChildren, []);
});

test("activatePluginRegistry exposes standard platform context to plugin setup", async () => {
  let seenPlatform;

  const registry = createPluginRegistry([
    {
      plugin: definePlugin({
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
    core: {},
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
