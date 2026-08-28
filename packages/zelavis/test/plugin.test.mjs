import assert from "node:assert/strict";
import test from "node:test";
import {
  activateServiceRegistry,
  applyServiceRegistryState,
  defineServiceCatalog,
  defineServiceCatalogEntry,
  defineService,
  createServiceRegistry,
  loadService,
  loadServiceRegistry,
  removeServiceFromRegistry,
  resolveServiceModule,
  serializeServiceRegistryState,
  isChildServiceAllowed,
  ZELAVIS_SERVICE_V1,
} from "../dist/index.js";

test("defineService normalizes service metadata for developer-facing extensions", () => {
  const runtimeService = {
    name: "commerce",
    service: {},
    api: {
      v1: [],
    },
  };

  const service = defineService({
    name: "@zelavis/ecommerce",
    version: "1.0.0",
    childServices: ["@zelavis/ecommerce-stripe"],
    menu: {
      title: "Ecommerce",
      path: "/commerce",
      pageLabel: "Commerce",
    },
    runtimeServices: [runtimeService],
  });

  assert.equal(service.name, "@zelavis/ecommerce");
  assert.equal(service.contractVersion, ZELAVIS_SERVICE_V1);
  assert.equal(service.menu.title, "Ecommerce");
  assert.equal(service.menu.path, "/commerce");
  assert.deepEqual(service.childServices, ["@zelavis/ecommerce-stripe"]);
  assert.equal(service.runtimeServices.length, 1);
  assert.ok(Object.isFrozen(service));
  assert.ok(Object.isFrozen(service.menu));
  assert.ok(Object.isFrozen(service.runtimeServices));
  assert.ok(Object.isFrozen(service.childServices));
});

test("defineService validates required service fields", () => {
  assert.throws(
    () =>
      defineService({
        name: "",
      }),
    /string name/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@example/broken-service",
        menu: {
          title: "Broken",
          path: 123,
        },
      }),
    /path must be a string/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@example/future-service",
        contractVersion: "ZELAVIS_SERVICE_V2",
      }),
    /Unsupported service contract version/,
  );

  // surface is now allowed in definitions — the activation layer strips it
  // for workspace-scoped services at runtime, so no throw at define-time.
  assert.doesNotThrow(() =>
    defineService({
      name: "@example/surface-service",
      menu: {
        title: "Surface",
        path: "/surface",
        surface: "root",
      },
    }),
  );

  assert.throws(
    () =>
      defineService({
        name: "@zelavis/ecommerce-stripe",
        extends: "",
      }),
    /Zelavis built-in name|scoped package name/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@zelavis/ecommerce-stripe",
        extends: "@zelavis/ecommerce",
        menu: {
          title: "Stripe",
          path: "/stripe",
        },
      }),
    /Child services cannot declare top-level dashboard menu metadata/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@zelavis/ecommerce",
        childServices: ["@zelavis/ecommerce-stripe", "@zelavis/ecommerce-stripe"],
      }),
    /Duplicate: @zelavis\/ecommerce-stripe/,
  );

  assert.throws(
    () =>
      defineService({
        name: "stripe",
      }),
    /Zelavis built-in name|scoped package name/,
  );

  assert.throws(
    () =>
      defineService({
        name: "@zelavis/ecommerce",
        childServices: ["stripe"],
      }),
    /Zelavis built-in name|scoped package name/,
  );
});

test("defineService supports child service extension metadata", () => {
  const service = defineService({
    name: "@zelavis/ecommerce-stripe",
    extends: "@zelavis/ecommerce",
  });

  assert.equal(service.extends, "@zelavis/ecommerce");
});

test("isChildServiceAllowed applies parent child service allow-list", () => {
  const parent = {
    service: defineService({
      name: "@zelavis/ecommerce",
      childServices: ["@zelavis/ecommerce-stripe"],
    }),
    status: "installed",
  };
  const stripe = {
    service: defineService({
      name: "@zelavis/ecommerce-stripe",
      extends: "@zelavis/ecommerce",
    }),
    status: "installed",
  };
  const xyz = {
    service: defineService({
      name: "@example/xyz-payments",
      extends: "@zelavis/ecommerce",
    }),
    status: "installed",
  };
  const shipping = {
    service: defineService({
      name: "@example/ship-fast",
      extends: "@zelavis/ecommerce",
    }),
    status: "installed",
  };

  assert.equal(isChildServiceAllowed(parent, stripe), true);
  assert.equal(isChildServiceAllowed(parent, xyz), false);
  assert.equal(isChildServiceAllowed(parent, shipping), false);
});

test("defineServiceCatalogEntry normalizes marketplace metadata", () => {
  const entry = defineServiceCatalogEntry({
    name: "@zelavis/ecommerce-stripe",
    package: "@zelavis/ecommerce-stripe",
    publisher: "zelavis",
    source: "official",
    extends: "@zelavis/ecommerce",
    compatibility: {
      zelavis: "^1.0.0",
      parentService: "^1.0.0",
    },
    links: {
      repository: "https://github.com/zelavis/zelavis",
    },
    tags: ["payments", "@zelavis/ecommerce-stripe"],
  });

  assert.equal(entry.reviewStatus, "official");
  assert.equal(entry.verified, true);
  assert.equal(entry.extends, "@zelavis/ecommerce");
  assert.equal(entry.compatibility.zelavis, "^1.0.0");
  assert.equal(entry.links.repository, "https://github.com/zelavis/zelavis");
  assert.deepEqual(entry.tags, ["payments", "@zelavis/ecommerce-stripe"]);
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
      defineServiceCatalogEntry({
        name: "@example/broken",
        package: "@example/broken",
        publisher: "example",
        source: "community",
        reviewStatus: "mystery",
      }),
    /reviewStatus must be "official", "reviewed", "unreviewed", or "blocked"/,
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
        name: "@zelavis/ecommerce",
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
  assert.equal(registry[0].service.menu.items[0].title, "Orders");
  assert.ok(Object.isFrozen(registry));
});

test("defineService allows nested menu groups without a fake path", () => {
  const service = defineService({
    name: "@zelavis/ecommerce",
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

  assert.equal(service.menu.items[0].title, "More");
  assert.equal(service.menu.items[0].path, undefined);
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

test("loadService uses the provided ESM importer", async () => {
  const service = await loadService("virtual:ecommerce", {
    importer: async (specifier) => ({
      service: {
        name: specifier.endsWith("ecommerce")
          ? "@zelavis/ecommerce"
          : "@example/unknown",
        menu: {
          title: "Ecommerce",
          path: "/commerce",
        },
      },
    }),
  });

  assert.equal(service.name, "@zelavis/ecommerce");
  assert.equal(service.menu.path, "/commerce");
});

test("loadServiceRegistry normalizes imported service modules", async () => {
  const registry = await loadServiceRegistry(
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
          name: specifier.endsWith("ecommerce")
            ? "@zelavis/ecommerce"
            : "@example/analytics",
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
  assert.equal(registry[1].service.name, "@example/analytics");
});

test("removeServiceFromRegistry removes entries without mutating the original registry", () => {
  const registry = createServiceRegistry([
    {
      service: {
        name: "@zelavis/ecommerce",
        menu: {
          title: "Ecommerce",
          path: "/commerce",
        },
      },
      status: "installed",
      source: "official",
    },
    {
      service: {
        name: "@example/analytics",
        menu: {
          title: "Analytics",
          path: "/analytics",
        },
      },
      status: "available",
      source: "community",
    },
  ]);

  const nextRegistry = removeServiceFromRegistry(registry, "@zelavis/ecommerce");

  assert.equal(registry.length, 2);
  assert.equal(nextRegistry.length, 1);
  assert.equal(nextRegistry[0].service.name, "@example/analytics");
});

test("applyServiceRegistryState overlays stored install state and order", () => {
  const registry = createServiceRegistry([
    {
      service: {
        name: "@zelavis/ecommerce",
      },
      status: "available",
      source: "official",
    },
    {
      service: {
        name: "@example/analytics",
      },
      status: "available",
      source: "community",
    },
  ]);

  const nextRegistry = applyServiceRegistryState(registry, [
    {
      name: "@example/analytics",
      status: "installed",
      order: 1,
    },
    {
      name: "@zelavis/ecommerce",
      status: "installed",
      order: 0,
    },
  ]);

  assert.equal(nextRegistry[0].status, "installed");
  assert.equal(nextRegistry[0].order, 0);
  assert.equal(nextRegistry[1].status, "installed");
  assert.deepEqual(serializeServiceRegistryState(nextRegistry), [
    {
      name: "@zelavis/ecommerce",
      status: "installed",
      source: "official",
      order: 0,
    },
    {
      name: "@example/analytics",
      status: "installed",
      source: "community",
      order: 1,
    },
  ]);
});

test("activateServiceRegistry runs installed services in order and collects services", async () => {
  const activationOrder = [];
  const firstService = {
    name: "first-service",
    service: {},
    api: { v1: [] },
  };
  const secondService = {
    name: "second-service",
    service: {},
    api: { v1: [] },
  };

  const registry = createServiceRegistry([
    {
      service: defineService({
        name: "@example/second",
        setup(context) {
          activationOrder.push(context.service.name);
          context.addService(secondService);
        },
      }),
      status: "installed",
      order: 2,
    },
    {
      service: defineService({
        name: "@example/first",
        runtimeServices: [firstService],
        setup(context) {
          activationOrder.push(context.service.name);
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      service: defineService({
        name: "@example/available-only",
      }),
      status: "available",
    },
  ]);

  const activated = await activateServiceRegistry(registry, {
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

  assert.deepEqual(activationOrder, ["@example/first", "@example/second"]);
  assert.deepEqual(
    activated.services.map((service) => service.name),
    ["first-service", "second-service"],
  );
});

test("activateServiceRegistry gives child services to their parent without activating them directly", async () => {
  const activationOrder = [];
  let seenChildren = [];

  const registry = createServiceRegistry([
    {
      service: defineService({
        name: "@zelavis/ecommerce-stripe",
        extends: "@zelavis/ecommerce",
        setup() {
          activationOrder.push("@zelavis/ecommerce-stripe");
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      service: defineService({
        name: "@zelavis/ecommerce",
        childServices: ["@zelavis/ecommerce-stripe"],
        setup(context) {
          activationOrder.push("@zelavis/ecommerce");
          seenChildren = context.children;
        },
      }),
      status: "installed",
      order: 1,
    },
  ]);

  await activateServiceRegistry(registry, {
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

  assert.deepEqual(activationOrder, ["@zelavis/ecommerce"]);
  assert.equal(seenChildren.length, 1);
  assert.equal(seenChildren[0].name, "@zelavis/ecommerce-stripe");
  assert.equal(seenChildren[0].extends, "@zelavis/ecommerce");
});

test("activateServiceRegistry withholds child services not listed by the parent", async () => {
  let seenChildren = [];

  const registry = createServiceRegistry([
    {
      service: defineService({
        name: "@example/xyz-payments",
        extends: "@zelavis/ecommerce",
        setup() {
          throw new Error("Rejected child services should not activate.");
        },
      }),
      status: "installed",
      order: 0,
    },
    {
      service: defineService({
        name: "@zelavis/ecommerce",
        childServices: ["@zelavis/ecommerce-stripe"],
        setup(context) {
          seenChildren = context.children;
        },
      }),
      status: "installed",
      order: 1,
    },
  ]);

  await activateServiceRegistry(registry, {
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

test("activateServiceRegistry exposes standard platform context to service setup", async () => {
  let seenPlatform;

  const registry = createServiceRegistry([
    {
      service: defineService({
        name: "@example/platform-aware",
        setup(context) {
          seenPlatform = context.platform;
        },
      }),
      status: "installed",
      order: 0,
    },
  ]);

  await activateServiceRegistry(registry, {
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    core: {},
    platform: {
      presets: ["node", "libsql"],
      resources: {
        keyValueStore: true,
        fileStorage: false,
      },
      metadata: {
        deployment: "self-hosted",
      },
    },
  });

  assert.deepEqual(seenPlatform, {
    presets: ["node", "libsql"],
    resources: {
      keyValueStore: true,
      fileStorage: false,
    },
    metadata: {
      deployment: "self-hosted",
    },
  });
});
