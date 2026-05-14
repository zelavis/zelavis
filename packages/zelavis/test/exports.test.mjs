import assert from "node:assert/strict";
import test from "node:test";

test("zelavis package exports runtime APIs, env adapters, and framework utility subpaths", async () => {
  const runtime = await import("zelavis");
  const adapters = await import("zelavis/adapters");
  const nodeAdapter = await import("zelavis/adapters/node");
  const bunAdapter = await import("zelavis/adapters/bun");
  const cloudflareAdapter = await import("zelavis/adapters/cloudflare");
  const netlifyAdapter = await import("zelavis/adapters/netlify");
  const vercelAdapter = await import("zelavis/adapters/vercel");
  const expressUtil = await import("zelavis/express");
  const honoUtil = await import("zelavis/hono");
  const fastifyUtil = await import("zelavis/fastify");
  const h3Util = await import("zelavis/h3");
  const elysiaUtil = await import("zelavis/elysia");
  const nextjsPagesUtil = await import("zelavis/nextjs/pages");
  const nodeServerUtil = await import("zelavis/node");
  const s3Storage = await import("zelavis/storage/s3");

  assert.equal(typeof runtime.zelavis, "function");
  assert.equal(typeof runtime.Zelavis, "function");
  assert.equal(typeof runtime.defineAdapter, "function");
  assert.equal(typeof runtime.definePlugin, "function");
  assert.equal(typeof runtime.createPluginRegistry, "function");
  assert.equal(runtime.ZELAVIS_PLUGIN_V1, "ZELAVIS_PLUGIN_V1");
  assert.equal(typeof runtime.loadPlugin, "function");
  assert.equal(typeof runtime.loadPluginRegistry, "function");
  assert.equal(typeof runtime.resolvePluginModule, "function");
  assert.equal(typeof runtime.removePluginFromRegistry, "function");
  assert.equal(typeof runtime.createDatabase, "function");
  assert.equal(typeof runtime.createFileReference, "function");
  assert.equal(typeof runtime.createS3CompatibleFileStorage, "function");
  assert.equal(typeof runtime.resolveS3CacheControlPreset, "function");
  assert.equal(typeof runtime.defineService, "function");
  assert.equal("zelavisServer" in runtime, false);

  // Env adapters via the barrel
  assert.equal(typeof adapters.zelavisNode, "function");
  assert.equal(typeof adapters.zelavisBun, "function");
  assert.equal(typeof adapters.zelavisCloudflare, "function");
  assert.equal(typeof adapters.zelavisVercel, "function");
  assert.equal(typeof adapters.zelavisNetlify, "function");

  // Env adapters via deep paths (named exports)
  assert.equal(typeof nodeAdapter.nodeAdapter, "function");
  assert.equal(typeof nodeAdapter.createFileDashboardSettingsStore, "function");
  assert.equal(typeof bunAdapter.bunAdapter, "function");
  assert.equal(typeof cloudflareAdapter.cloudflareAdapter, "function");
  assert.equal(typeof netlifyAdapter.netlifyAdapter, "function");
  assert.equal(typeof vercelAdapter.vercelAdapter, "function");

  // Framework utility helpers
  assert.equal(typeof expressUtil.expressMiddleware, "function");
  assert.equal(typeof honoUtil.honoMiddleware, "function");
  assert.equal(typeof fastifyUtil.fastifyPlugin, "function");
  assert.equal(typeof h3Util.h3Handler, "function");
  assert.equal(typeof elysiaUtil.elysiaPlugin, "function");
  assert.equal(typeof nextjsPagesUtil.nextjsPagesRouterHandler, "function");
  assert.equal(typeof nodeServerUtil.createNodeServer, "function");

  // Storage helpers
  assert.equal(typeof s3Storage.createS3CompatibleFileStorage, "function");
  assert.equal(typeof s3Storage.resolveS3CacheControlPreset, "function");
});

test("Zelavis accepts a node env adapter and exposes a Node HTTP server through the utility", async () => {
  const { Zelavis } = await import("zelavis");
  const { nodeAdapter } = await import("zelavis/adapters/node");
  const { createNodeServer } = await import("zelavis/node");

  const zelavis = new Zelavis({
    adapter: nodeAdapter(),
  });

  const server = await createNodeServer(zelavis);
  assert.equal(typeof server.listen, "function");
});

test("cloudflare adapter requires the standard D1 binding when env is provided", async () => {
  const { cloudflareAdapter } = await import("zelavis/adapters/cloudflare");

  await assert.rejects(
    () => cloudflareAdapter({ env: {} }).resolve({}),
    /Missing or invalid Cloudflare D1 binding `ZELAVIS_DB`/,
  );
});

test("cloudflare adapter infers KV and file resources from standard env bindings", async () => {
  const { cloudflareAdapter } = await import("zelavis/adapters/cloudflare");
  const database = {
    prepare() {
      return {
        bind() {
          return this;
        },
        all: async () => ({ results: [], success: true }),
        run: async () => ({ success: true }),
      };
    },
    async batch() {
      return [];
    },
  };

  const kv = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list() {
      return { keys: [], list_complete: true };
    },
  };
  const bucket = {
    async get() {
      return null;
    },
    async put() {},
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
  };

  const resolved = await cloudflareAdapter({
    env: {
      ZELAVIS_DB: database,
      ZELAVIS_KV: kv,
      ZELAVIS_FILES: bucket,
    },
  }).resolve({});

  assert.equal(typeof resolved.resources.kv.get, "function");
  assert.equal(typeof resolved.resources.files.put, "function");
});

test("Zelavis rejects internal runtime options on the public class constructor", async () => {
  const { Zelavis } = await import("zelavis");

  assert.throws(
    () =>
      new Zelavis({
        coreServices: {
          dashboard: false,
        },
      }),
    /does not accept internal runtime options/,
  );

  assert.throws(
    () =>
      new Zelavis({
        services: [],
      }),
    /does not accept internal runtime options/,
  );
});

test("Zelavis applies adapter resolve output as platform resources, metadata, and presets", async () => {
  const { Zelavis, defineAdapter } = await import("zelavis");

  const adapter = defineAdapter({
    name: "capture",
    resolve() {
      return {
        metadata: { runtime: "custom", marker: true },
        resources: {
          kv: {
            get() {
              return "alpha";
            },
            set() {},
            delete() {
              return true;
            },
          },
        },
      };
    },
  });

  const zelavis = new Zelavis({ adapter });
  await zelavis.runtime();

  assert.deepEqual(zelavis.platform.presets, ["capture"]);
  assert.equal(zelavis.platform.metadata.runtime, "custom");
  assert.equal(zelavis.platform.metadata.marker, true);
  assert.equal(zelavis.platform.resources.kv.get("x"), "alpha");
});

test("Zelavis platform resources back dashboard settings, website pages, storage service, and ecommerce persistence", async () => {
  const { Zelavis, defineAdapter, createDatabase, zelavis: createZelavis } =
    await import("zelavis");

  const kv = new Map();
  const files = new Map();

  const adapter = defineAdapter({
    name: "storage-only",
    resolve() {
      return {
        coreServices: {
          database: false,
        },
        resources: {
          kv: {
            get(key) {
              return kv.get(key);
            },
            set(key, value) {
              kv.set(key, value);
            },
            delete(key) {
              return kv.delete(key);
            },
          },
          files: {
            get(path) {
              return files.get(path);
            },
            put(input) {
              const body =
                typeof input.body === "string"
                  ? new TextEncoder().encode(input.body)
                  : input.body instanceof Uint8Array
                    ? input.body
                    : input.body instanceof ArrayBuffer
                      ? new Uint8Array(input.body)
                      : new Uint8Array();
              const entry = {
                path: input.path,
                body,
                size: body.byteLength,
                updatedAt: new Date(),
                contentType: input.contentType,
                metadata: input.metadata,
              };
              files.set(input.path, entry);
              return entry;
            },
            delete(path) {
              return files.delete(path);
            },
            list(prefix) {
              return [...files.values()]
                .filter((entry) => (prefix ? entry.path.startsWith(prefix) : true))
                .map((entry) => ({
                  path: entry.path,
                  size: entry.size,
                  updatedAt: entry.updatedAt,
                  contentType: entry.contentType,
                  metadata: entry.metadata,
                }));
            },
          },
        },
      };
    },
  });

  const zelavis = new Zelavis({
    adapter,
    plugins: {
      store: {
        read() {
          return [
            {
              name: "zelavis-ecommerce",
              status: "installed",
              order: 0,
            },
          ];
        },
        write(entries) {
          return entries;
        },
      },
    },
  });

  const commerceHealthResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/health"),
  );
  const commerceHealth = await commerceHealthResponse.json();

  assert.equal(commerceHealthResponse.status, 200);
  assert.equal(commerceHealth.plugin, "zelavis-ecommerce");
  assert.deepEqual(commerceHealth.platform.presets, ["storage-only"]);
  assert.deepEqual(commerceHealth.platform.resources, {
    keyValueStore: true,
    fileStorage: true,
  });

  const createCustomerResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/customers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "shopper@example.com",
        firstName: "Shop",
        lastName: "Per",
      }),
    }),
  );
  const createdCustomer = await createCustomerResponse.json();

  assert.equal(createCustomerResponse.status, 201);
  assert.equal(createdCustomer.email, "shopper@example.com");
  assert.equal(typeof createdCustomer.id, "string");

  const createProductResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/products", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Starter Hoodie",
        price: {
          amount: 5900,
          currency: "USD",
        },
      }),
    }),
  );
  const createdProduct = await createProductResponse.json();

  assert.equal(createProductResponse.status, 201);
  assert.equal(createdProduct.title, "Starter Hoodie");
  assert.equal(createdProduct.slug, "starter-hoodie");

  const listProductsResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/products"),
  );
  const listedProducts = await listProductsResponse.json();

  assert.equal(listProductsResponse.status, 200);
  assert.equal(listedProducts.length, 1);
  assert.equal(listedProducts[0].id, createdProduct.id);

  const createOrderResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/orders", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customerId: createdCustomer.id,
        items: [
          {
            productId: createdProduct.id,
            quantity: 2,
            unitPrice: 5900,
          },
        ],
        totals: {
          subtotal: 11800,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: 11800,
          currency: "USD",
        },
      }),
    }),
  );
  const createdOrder = await createOrderResponse.json();

  assert.equal(createOrderResponse.status, 201);
  assert.equal(createdOrder.customerId, createdCustomer.id);
  assert.equal(createdOrder.items.length, 1);

  const listPaymentProvidersResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/payments/providers"),
  );
  const paymentProviders = await listPaymentProvidersResponse.json();

  assert.equal(listPaymentProvidersResponse.status, 200);
  assert.deepEqual(paymentProviders.providers, []);

  const databaseBacked = await createDatabase();
  const firstRuntime = await createZelavis({
    coreServices: {
      database: databaseBacked,
    },
    plugins: {
      store: {
        read() {
          return [
            {
              name: "zelavis-ecommerce",
              status: "installed",
              order: 0,
            },
          ];
        },
        write(entries) {
          return entries;
        },
      },
    },
  });

  const persistedProductResponse = await firstRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/products", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Persisted Mug",
        price: {
          amount: 2400,
          currency: "USD",
        },
      }),
    }),
  );

  assert.equal(persistedProductResponse.status, 201);

  const secondRuntime = await createZelavis({
    coreServices: {
      database: databaseBacked,
    },
    plugins: {
      store: {
        read() {
          return [
            {
              name: "zelavis-ecommerce",
              status: "installed",
              order: 0,
            },
          ];
        },
        write(entries) {
          return entries;
        },
      },
    },
  });

  const persistedProductListResponse = await secondRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/products"),
  );
  const persistedProducts = await persistedProductListResponse.json();

  assert.equal(persistedProductListResponse.status, 200);
  assert.equal(persistedProducts.length, 1);
  assert.equal(persistedProducts[0].title, "Persisted Mug");

  const updateResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/dashboard/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        theme: "dark",
      }),
    }),
  );

  assert.equal(updateResponse.status, 200);
  assert.equal(kv.has("zelavis/dashboard-settings.json"), true);

  const createPageResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "/",
        title: "Home",
      }),
    }),
  );

  assert.equal(createPageResponse.status, 201);
  assert.equal(files.has("zelavis/website-pages.json"), true);

  const uploadResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt", {
      method: "PUT",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-zelavis-meta-origin": "test",
      },
      body: "hello world",
    }),
  );

  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.file.path, "uploads/hello.txt");
  assert.equal(typeof uploaded.file.checksum, "string");
  assert.equal(uploaded.file.metadata.origin, "test");
  assert.equal(uploaded.reference.href, "/zelavis/api/v1/storage/files/uploads/hello.txt");
  assert.equal(files.has("uploads/hello.txt"), true);

  const listResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files?prefix=uploads/"),
  );
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  assert.equal(Array.isArray(listed.files), true);
  assert.equal(listed.files.some((file) => file.path === "uploads/hello.txt"), true);
  assert.equal(Array.isArray(listed.references), true);

  const metadataResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt?format=metadata"),
  );
  assert.equal(metadataResponse.status, 200);
  const metadataBody = await metadataResponse.json();
  assert.equal(metadataBody.file.path, "uploads/hello.txt");
  assert.equal(metadataBody.file.metadata.origin, "test");
  assert.equal(typeof metadataBody.file.checksum, "string");
  assert.equal(
    metadataBody.reference.metadataHref,
    "/zelavis/api/v1/storage/files/uploads/hello.txt?format=metadata",
  );

  const readResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt"),
  );
  assert.equal(readResponse.status, 200);
  assert.equal(typeof readResponse.headers.get("x-zelavis-checksum-sha256"), "string");
  assert.equal(await readResponse.text(), "hello world");

  const deleteResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt", {
      method: "DELETE",
    }),
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(files.has("uploads/hello.txt"), false);
});

test("Zelavis rejects installed plugins that try to register reserved core service names", async () => {
  const { Zelavis, definePlugin, createPluginRegistry, defineService } =
    await import("zelavis");

  const forbiddenPlugin = definePlugin({
    name: "evil-auth-plugin",
    services: [
      defineService({
        name: "auth",
        service: {},
        api: {
          v1: [],
        },
      }),
    ],
  });

  const zelavis = new Zelavis({
    plugins: {
      entries: createPluginRegistry([
        {
          plugin: forbiddenPlugin,
          status: "installed",
        },
      ]),
    },
  });

  await assert.rejects(
    () => zelavis.runtime(),
    /Plugins cannot register reserved core service names: auth/,
  );
});
