import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zelavisEcommerceService } from "../../../plugins/ecommerce/dist/index.js";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

test("zelavis package exports runtime APIs and local host adapters", async () => {
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const runtime = await import("zelavis");
  const core = await import("zelavis/core");
  const serviceRuntime = await import("zelavis/runtime");
  const fabric = await import("zelavis/fabric");
  const workload = await import("zelavis/workload");
  const artifact = await import("zelavis/artifact");
  const provider = await import("zelavis/provider");
  const app = await import("zelavis/app");
  const appAuth = await import("zelavis/app/auth");
  const appDatabase = await import("zelavis/app/db");
  const appWorkloads = await import("zelavis/app/workloads");
  const nodeSqlite = await import("zelavis/app/db/adapters/node-sqlite");
  const adapters = await import("zelavis/adapters");
  const nodeAdapter = await import("zelavis/adapters/node");
  const bunAdapter = await import("zelavis/adapters/bun");
  const nodeServerUtil = await import("zelavis/runtimes/node");
  const bunRuntime = await import("zelavis/runtimes/bun");
  const denoRuntime = await import("zelavis/runtimes/deno");
  const sdk = await import("zelavis/sdk");
  const browserSdk = await import("zelavis/sdk/browser");
  const nodeSdk = await import("zelavis/sdk/node");
  const s3Storage = await import("zelavis/storage/s3");

  assert.equal(typeof runtime.zelavis, "function");
  assert.equal(typeof runtime.Zelavis, "function");
  assert.equal(runtime.ZELAVIS_VERSION, packageMetadata.version);
  assert.equal(typeof runtime.defineAdapter, "function");
  assert.equal(typeof runtime.defineService, "function");
  assert.equal(typeof runtime.createServiceRegistry, "function");
  assert.equal(runtime.ZELAVIS_SERVICE_V1, "ZELAVIS_SERVICE_V1");
  assert.equal(typeof runtime.loadService, "function");
  assert.equal(typeof runtime.loadServiceRegistry, "function");
  assert.equal(typeof runtime.resolveServiceModule, "function");
  assert.equal(typeof runtime.removeServiceFromRegistry, "function");
  assert.equal("createDatabase" in runtime, false);
  assert.equal(typeof runtime.createFileReference, "function");
  assert.equal(typeof runtime.createS3CompatibleFileStorage, "function");
  assert.equal(typeof runtime.resolveS3CacheControlPreset, "function");
  assert.equal("createServiceRuntime" in runtime, false);

  // The former server/Fabric and App packages are focused Zelavis subpaths.
  assert.equal(typeof core.defineService, "function");
  assert.equal(typeof serviceRuntime.createServiceRuntime, "function");
  assert.equal(typeof fabric.createFabricService, "function");
  assert.equal(typeof fabric.planFabricProjectPlacements, "function");
  assert.equal(typeof workload, "object");
  assert.equal(typeof artifact.defineRuntimeArtifact, "function");
  assert.equal(typeof provider.defineProvider, "function");
  assert.equal(typeof app.zelavisAppService, "function");
  assert.equal(app.zelavisApp.version, runtime.ZELAVIS_VERSION);
  assert.equal(typeof appAuth.createAuth, "function");
  assert.equal(typeof appDatabase.createDatabase, "function");
  assert.equal(typeof appWorkloads.workloadsService, "function");
  assert.equal(typeof nodeSqlite.createBetterSqlite3Database, "function");

  // Local runtime adapters via the barrel
  assert.equal(typeof adapters.zelavisNode, "function");
  assert.equal(typeof adapters.zelavisBun, "function");
  assert.equal(typeof adapters.createNodeServicePackageInstaller, "function");

  // Local runtime adapters via deep paths (named exports)
  assert.equal(typeof nodeAdapter.nodeAdapter, "function");
  assert.equal(typeof nodeAdapter.createNodeServiceImporter, "function");
  assert.equal(typeof nodeAdapter.createNodeServicePackageInstaller, "function");
  assert.equal(typeof bunAdapter.bunAdapter, "function");

  // Long-running Node host utility
  assert.equal(nodeServerUtil.node, true);
  assert.equal(typeof nodeServerUtil.createNodeServer, "function");
  assert.equal(bunRuntime.bun, true);
  assert.equal(denoRuntime.deno, true);

  // SDK bundle surfaces
  assert.equal(typeof sdk.createZelavisClient, "function");
  assert.equal(sdk.fetchSdkSurface.excludes.ui, true);
  assert.deepEqual(sdk.fetchSdkSurface.excludes.runtimes, [
    "node",
    "bun",
    "deno",
  ]);
  assert.equal(browserSdk.browser, true);
  assert.equal(typeof browserSdk.createBrowserZelavisClient, "function");
  assert.equal(nodeSdk.nodeSdk, true);
  assert.equal(typeof nodeSdk.createNodeZelavisClient, "function");

  // Storage helpers
  assert.equal(typeof s3Storage.createS3CompatibleFileStorage, "function");
  assert.equal(typeof s3Storage.resolveS3CacheControlPreset, "function");
});

test("SDK browser surface compiles without runtime host or dashboard imports", async () => {
  const emitted = await Promise.all([
    readFile(new URL("../dist/sdk/browser.js", import.meta.url), "utf8"),
    readFile(new URL("../dist/sdk/fetch.js", import.meta.url), "utf8"),
  ]);
  const joined = emitted.join("\n");

  assert.equal(/from ["']@zelavis\/ui/.test(joined), false);
  assert.equal(/from ["']@zelavis\/server/.test(joined), false);
  assert.equal(/from ["']node:/.test(joined), false);
  assert.equal(/from ["']better-sqlite3/.test(joined), false);
  assert.equal(/from ["']@zelavis\/app-db-node-sqlite/.test(joined), false);
  assert.equal(/from ["']@zelavis\/app-db-bun-sqlite/.test(joined), false);
  assert.equal(/from ["']\.\.\/runtimes\//.test(joined), false);
  assert.equal(/from ["']\.\.\/adapters\//.test(joined), false);
});

test("SDK client resolves Zelavis runtime endpoints through native fetch", async () => {
  const { createZelavisClient } = await import("zelavis/sdk/browser");
  const requested = [];
  const client = createZelavisClient({
    baseUrl: "https://example.test",
    fetch(input, init) {
      requested.push({ input: String(input), init });
      return Response.json({ ok: true });
    },
  });

  assert.deepEqual(await client.runtime.config(), { ok: true });
  assert.equal(
    requested[0].input,
    "https://example.test/zelavis/api/v1/runtime/config",
  );
});

test("Zelavis accepts a node env adapter and exposes a Node HTTP server through the utility", async () => {
  const { Zelavis } = await import("zelavis");
  const { nodeAdapter } = await import("zelavis/adapters/node");
  const { createNodeServer } = await import("zelavis/runtimes/node");

  const directory = await mkdtemp(join(tmpdir(), "zelavis-exports-"));
  const zelavis = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: directory }),
  });

  try {
    const server = await createNodeServer(zelavis);
    assert.equal(typeof server.listen, "function");
  } finally {
    await zelavis.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Zelavis exposes default core APIs", async () => {
  const { Zelavis } = await import("zelavis");

  const zelavis = new Zelavis();
  const appDatabase = zelavis.db.forTenant("zelavis-app");

  await appDatabase.documents.createCollection({ name: "posts" });
  const doc = await appDatabase.documents.insert({
    collection: "posts",
    data: { title: "Hello", published: false },
  });
  const found = await appDatabase.documents.findById({
    collection: "posts",
    id: doc.id,
  });

  assert.equal(found.data.title, "Hello");
  const database = await zelavis.resolveDatabaseApi();
  const runtime = await zelavis.runtime();
  assert.equal(
    database.forTenant("zelavis-app").documents,
    runtime.services["@zelavis/db"].service.forTenant("zelavis-app").documents,
  );
  assert.equal(zelavis.db.context.nodeId, "local");
  assert.equal(typeof zelavis.auth.accounts.create, "function");
});

test("Zelavis rejects internal runtime options on the public class constructor", async () => {
  const { Zelavis } = await import("zelavis");

  assert.throws(
    () =>
      new Zelavis({
        runtimeServices: [],
      }),
    /does not accept internal runtime options/,
  );

  assert.throws(
    () =>
      new Zelavis({
        coreServices: {
          database: false,
        },
      }),
    /does not accept internal runtime options/,
  );

  assert.throws(
    () =>
      new Zelavis({
        services: {},
      }),
    /does not accept internal runtime options/,
  );

  assert.throws(
    () =>
      new Zelavis({
        serviceRegistry: {},
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
  const { Zelavis, defineAdapter, zelavis: createZelavis } =
    await import("zelavis");
  const { createDatabase } = await import("../dist/app/db/index.js");

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
        serviceRegistry: {
          catalog: [
            {
              service: zelavisEcommerceService,
              status: "installed",
              source: "official",
              order: 0,
            },
          ],
          store: {
            read() {
              return [
                {
                  name: "@zelavis/ecommerce",
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
      };
    },
  });

  const zelavis = new Zelavis({
    adapter,
  });

  const commerceHealthResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/health"),
  );
  const commerceHealth = await commerceHealthResponse.json();

  assert.equal(commerceHealthResponse.status, 200);
  assert.equal(commerceHealth.service, "@zelavis/ecommerce");
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
    serviceRegistry: {
      catalog: [
        {
          service: zelavisEcommerceService,
          status: "installed",
          source: "official",
          order: 0,
        },
      ],
      store: {
        read() {
          return [
            {
              name: "@zelavis/ecommerce",
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
    serviceRegistry: {
      catalog: [
        {
          service: zelavisEcommerceService,
          status: "installed",
          source: "official",
          order: 0,
        },
      ],
      store: {
        read() {
          return [
            {
              name: "@zelavis/ecommerce",
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
    new Request("http://localhost/zelavis/api/v1/runtime/settings", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        theme: "dark",
      }),
    }),
    PLATFORM_OWNER_CONTEXT,
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

test("Zelavis rejects installed services that try to register reserved core service names", async () => {
  const { Zelavis, defineAdapter, defineService, createServiceRegistry } =
    await import("zelavis");

  const forbiddenService = defineService({
    name: "@example/evil-auth-service",
    runtimeServices: [
      {
        name: "@zelavis/auth",
        service: {},
        api: {
          v1: [],
        },
      },
    ],
  });

  const zelavis = new Zelavis({
    adapter: defineAdapter({
      name: "reserved-service-test",
      resolve() {
        return {
          serviceRegistry: {
            catalog: createServiceRegistry([
              {
                service: forbiddenService,
                status: "installed",
              },
            ]),
          },
        };
      },
    }),
  });

  await assert.rejects(
    () => zelavis.runtime(),
    /Extension service "@example\/evil-auth-service" cannot register reserved runtime service "@zelavis\/auth"/,
  );
});
