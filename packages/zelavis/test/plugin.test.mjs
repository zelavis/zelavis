import assert from "node:assert/strict";
import test from "node:test";
import {
  activateServiceRegistry,
  applyServiceRegistryState,
  defineServiceCatalog,
  defineServiceCatalogEntry,
  createServiceRegistry,
  loadPluginPackage,
  loadService,
  loadServiceRegistry,
  removeServiceFromRegistry,
  resolveServiceModule,
  serializeServiceRegistryState,
  validatePluginPackageManifest,
  resolvePackageExportsEntry,
} from "../dist/index.js";
import { zelavis } from "../dist/sdk/fetch.js";

// ---------- Section 14: Exact Plugin Manifest Validation Messages ----------

test("validatePluginPackageManifest rejects missing zelavis.kind with exact message", () => {
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@example/foo",
        version: "1.0.0",
        type: "module",
        exports: "./dist/index.js",
      }),
    (error) => {
      assert.equal(
        error.message,
        'Invalid Zelavis service "@example/foo":\nmissing "zelavis.kind" in package.json.',
      );
      return true;
    },
  );
});

test("validatePluginPackageManifest rejects non-module plugins with exact message", () => {
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@example/foo",
        version: "1.0.0",
        exports: "./dist/index.js",
        zelavis: { kind: "plugin" },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Invalid Zelavis service "@example/foo":\npackage.json must contain "type": "module".',
      );
      return true;
    },
  );
});

test("validatePluginPackageManifest rejects plugins missing exports with exact message", () => {
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@example/foo",
        version: "1.0.0",
        type: "module",
        zelavis: { kind: "plugin" },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Invalid Zelavis service "@example/foo":\npackage.json must define "exports".',
      );
      return true;
    },
  );
});

test("validatePluginPackageManifest rejects legacy main in plugins with exact message", () => {
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@example/foo",
        version: "1.0.0",
        type: "module",
        main: "./dist/index.js",
        exports: "./dist/index.js",
        zelavis: { kind: "plugin" },
      }),
    (error) => {
      assert.equal(
        error.message,
        'Invalid Zelavis service "@example/foo":\n"main" is not supported.\nUse the modern "exports" field instead.',
      );
      return true;
    },
  );
});

test("validatePluginPackageManifest accepts valid modern plugin package.json", () => {
  const manifest = validatePluginPackageManifest({
    name: "@example/foo",
    version: "1.0.0",
    type: "module",
    exports: "./dist/index.js",
    zelavis: { kind: "plugin" },
  });

  assert.equal(manifest.name, "@example/foo");
  assert.equal(manifest.zelavis?.kind, "plugin");
});

test("resolvePackageExportsEntry resolves string and conditional exports", () => {
  assert.equal(resolvePackageExportsEntry("./dist/index.js"), "./dist/index.js");
  assert.equal(
    resolvePackageExportsEntry({ ".": "./dist/index.js" }),
    "./dist/index.js",
  );
  assert.equal(
    resolvePackageExportsEntry({ ".": { import: "./dist/index.js" } }),
    "./dist/index.js",
  );
  assert.equal(
    resolvePackageExportsEntry({ import: "./dist/index.js" }),
    "./dist/index.js",
  );
});

// ---------- Official Zelavis JS/TS SDK as Plugin API ----------

test("zelavis SDK throws descriptive error when called outside active plugin context", () => {
  assert.throws(
    () => zelavis.menu.create({ title: "Test", path: "/test" }),
    /zelavis\.menu\.create can only be called within an active Zelavis plugin execution context\./,
  );

  assert.throws(
    () =>
      zelavis.routes.create({
        id: "test",
        method: "GET",
        path: "/test",
        handler: () => ({ status: 200 }),
      }),
    /zelavis\.routes\.create can only be called within an active Zelavis plugin execution context\./,
  );

  assert.throws(
    () =>
      zelavis.commands.register({
        name: "test-cmd",
        handler: () => "ok",
      }),
    /zelavis\.commands\.register can only be called within an active Zelavis plugin execution context\./,
  );

  assert.throws(
    () => zelavis.events.on("test-event", () => {}),
    /zelavis\.events\.on can only be called within an active Zelavis plugin execution context\./,
  );
});

test("loadPluginPackage executes plugin and attributes menus, routes, and commands", async () => {
  const manifest = {
    name: "@example/my-plugin",
    version: "1.2.0",
    type: "module",
    exports: "./index.js",
    zelavis: { kind: "plugin" },
  };

  const loadedService = await loadPluginPackage({
    manifest,
    importer: async () => {
      // Inside plugin module evaluation:
      zelavis.menu.create({
        title: "My Plugin",
        path: "/my-plugin",
      });

      zelavis.routes.create({
        id: "my-plugin.ping",
        method: "GET",
        path: "/ping",
        handler: () => ({ status: 200, body: { pong: true } }),
      });

      zelavis.commands.register({
        name: "my-plugin.greet",
        handler: (name) => `Hello, ${name}!`,
      });

      return { exportedValue: 42 };
    },
  });

  assert.equal(loadedService.name, "@example/my-plugin");
  assert.equal(loadedService.kind, "plugin");
  assert.equal(loadedService.menu?.title, "My Plugin");
  assert.equal(loadedService.menu?.path, "/my-plugin");
  assert.equal(loadedService.api?.v1?.length, 1);
  assert.equal(loadedService.api?.v1?.[0]?.id, "my-plugin.ping");
  assert.equal(loadedService.service?.exportedValue, 42);
});

// ---------- Service Catalog & Registry ----------

test("defineServiceCatalogEntry normalizes marketplace metadata", () => {
  const entry = defineServiceCatalogEntry({
    name: "@example/payments-gateway",
    package: "@example/payments-gateway",
    publisher: "zelavis",
    source: "official",
    compatibility: {
      zelavis: "^1.0.0",
      parentService: "^1.0.0",
    },
    links: {
      repository: "https://github.com/zelavis/zelavis",
    },
    tags: ["payments", "@example/payments-gateway"],
  });

  assert.equal(entry.reviewStatus, "official");
  assert.equal(entry.verified, true);
  assert.equal(entry.compatibility.zelavis, "^1.0.0");
  assert.equal(entry.links.repository, "https://github.com/zelavis/zelavis");
  assert.deepEqual(entry.tags, ["payments", "@example/payments-gateway"]);
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.compatibility));
  assert.ok(Object.isFrozen(entry.links));
  assert.ok(Object.isFrozen(entry.tags));
});

test("defineServiceCatalog validates marketplace entries", () => {
  assert.throws(
    () =>
      defineServiceCatalogEntry({
        name: "@example/broken",
        package: "@example/broken",
        publisher: "example",
        source: "unknown",
      }),
    /source must be "official" or "community"/,
  );

  assert.throws(
    () =>
      defineServiceCatalog([
        {
          name: "@example/analytics",
          package: "@example/analytics",
          publisher: "example",
          source: "community",
        },
        {
          name: "@example/analytics",
          package: "@example/analytics-two",
          publisher: "example",
          source: "community",
        },
      ]),
    /unique names/,
  );
});

test("createServiceRegistry normalizes service registry entries", () => {
  const registry = createServiceRegistry([
    {
      service: {
        name: "@example/catalog",
        menu: {
          title: "Catalog",
          path: "/catalog",
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
  assert.equal(registry[0].service.menu.items[0].title, "Orders");
  assert.ok(Object.isFrozen(registry));
});

test("resolveServiceModule accepts named or default ESM exports", () => {
  const named = resolveServiceModule({
    service: {
      name: "@example/named-service",
      menu: {
        title: "Named",
        path: "/named",
      },
    },
  });
  const byDefault = resolveServiceModule({
    default: {
      name: "@example/default-service",
      menu: {
        title: "Default",
        path: "/default",
      },
    },
  });

  assert.equal(named.name, "@example/named-service");
  assert.equal(byDefault.name, "@example/default-service");
});

test("resolveServiceModule preserves Project recipe metadata", () => {
  const recipe = resolveServiceModule({
    default: {
      name: "@example/project-recipe",
      kind: "app",
      version: "1.2.3",
      project: { runtimeKinds: ["native"] },
      marketplace: { title: "Example App" },
      capabilities: ["app:project"],
    },
  });

  assert.equal(recipe.kind, "app");
  assert.deepEqual(recipe.project, { runtimeKinds: ["native"] });
  assert.deepEqual(recipe.marketplace, { title: "Example App" });
  assert.deepEqual(recipe.capabilities, ["app:project"]);
});

test("removeServiceFromRegistry removes entries by name", () => {
  const registry = createServiceRegistry([
    {
      service: { name: "@example/one" },
      status: "installed",
    },
    {
      service: { name: "@example/two" },
      status: "available",
    },
  ]);

  const filtered = removeServiceFromRegistry(registry, "@example/one");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].service.name, "@example/two");
});

test("serializeServiceRegistryState captures persistent configuration", () => {
  const registry = createServiceRegistry([
    {
      service: { name: "@example/installed" },
      specifier: "@example/installed",
      status: "installed",
      source: "community",
      order: 10,
    },
  ]);

  const state = serializeServiceRegistryState(registry);
  assert.deepEqual(state, [
    {
      name: "@example/installed",
      specifier: "@example/installed",
      status: "installed",
      source: "community",
      order: 10,
    },
  ]);
});

test("applyServiceRegistryState restores persisted status and order", () => {
  const registry = createServiceRegistry([
    {
      service: { name: "@example/service" },
      status: "available",
      source: "community",
      order: 10,
    },
  ]);

  const applied = applyServiceRegistryState(registry, [
    {
      name: "@example/service",
      status: "installed",
      order: 5,
    },
  ]);

  assert.equal(applied[0].status, "installed");
  assert.equal(applied[0].order, 5);
});

test("activateServiceRegistry mounts installed services in order", async () => {
  const first = {
    name: "@example/first",
    api: {
      v1: [
        {
          id: "first.ping",
          method: "GET",
          path: "/first",
          handler: () => ({ status: 200 }),
        },
      ],
    },
  };

  const second = {
    name: "@example/second",
    api: {
      v1: [
        {
          id: "second.ping",
          method: "GET",
          path: "/second",
          handler: () => ({ status: 200 }),
        },
      ],
    },
  };

  const registry = createServiceRegistry([
    {
      service: second,
      status: "installed",
      order: 20,
    },
    {
      service: first,
      status: "installed",
      order: 10,
    },
  ]);

  const activated = await activateServiceRegistry(registry, {
    rootPath: "",
    api: { prefix: "/api", version: "v1", basePath: "/api/v1" },
    platform: { presets: [], resources: { keyValueStore: true, fileStorage: true }, metadata: {} },
    core: {},
  });

  assert.equal(activated.services.length, 2);
  assert.equal(activated.services[0].name, "@example/first");
  assert.equal(activated.services[1].name, "@example/second");
});

// ---------- Core stays filesystem-free; hosts supply manifest resolution ----------

test("the runtime core never resolves plugin manifests from a filesystem", async () => {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createLocalRuntimeServiceManifestResolver } = await import(
    "../dist/adapters/_local-runtime.js"
  );

  const directory = await mkdtemp(join(tmpdir(), "zelavis-plugin-"));
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@zelavis/manifest-boundary-fixture",
      type: "module",
      exports: "./index.js",
      zelavis: { kind: "plugin" },
    }),
  );

  // With no resolver supplied the core must not read package.json at all.
  await assert.rejects(
    loadService(directory, {
      importer: () => {
        throw new Error("filesystem-free core reached the importer");
      },
    }),
    /filesystem-free core reached the importer/,
  );

  // A local host supplies the resolver explicitly, per call.
  const resolver = createLocalRuntimeServiceManifestResolver();
  const manifest = await resolver(directory);
  assert.equal(manifest.name, "@zelavis/manifest-boundary-fixture");
  assert.equal(manifest.zelavis.kind, "plugin");

  // Remote and data specifiers are never treated as filesystem paths.
  assert.equal(await resolver("https://example.com/plugin.js"), undefined);
  assert.equal(await resolver("data:text/javascript,export default {}"), undefined);
});

test("manifest resolution is per runtime, not process global", async () => {
  const { nodeAdapter } = await import("../dist/adapters/node.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Two adapters in one process must each carry their own resolver rather than
  // installing one globally, where the second would silently affect the first.
  const first = nodeAdapter({
    dataDirectory: await mkdtemp(join(tmpdir(), "zelavis-resolver-a-")),
  });
  const second = nodeAdapter({
    dataDirectory: await mkdtemp(join(tmpdir(), "zelavis-resolver-b-")),
  });

  const firstOptions = await first.resolve({});
  const secondOptions = await second.resolve({});

  assert.equal(typeof firstOptions.serviceRegistry?.manifestResolver, "function");
  assert.equal(typeof secondOptions.serviceRegistry?.manifestResolver, "function");
  assert.notEqual(
    firstOptions.serviceRegistry.manifestResolver,
    secondOptions.serviceRegistry.manifestResolver,
    "each runtime must own its resolver",
  );
});
