import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEcommercePlugin } from "./load-plugin.mjs";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

/**
 * The plugin's own persistence, exercised through a real Zelavis runtime.
 *
 * This lived in the Platform's test suite, which meant core could not run its
 * tests without building a shopping cart, and a change here could fail the
 * Platform. What core needs from a plugin — that it mounts, gets its setup
 * context, and receives platform resources — is covered there against a
 * fixture that belongs to nobody.
 */
test("commerce persists customers, products and orders across runtimes", async (t) => {
  const { Zelavis, defineAdapter, zelavis: createZelavis } =
    await import("../../../packages/zelavis/dist/index.js");

  // One directory, shared by both runtimes: persisting across runtimes is the
  // whole claim, and two directories would let a runtime that stored nothing
  // pass by starting empty each time.
  const directory = mkdtempSync(join(tmpdir(), "zv-ecommerce-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const kv = new Map();
  const files = new Map();

  const adapter = defineAdapter({
    name: "storage-only",
    async resolve() {
      return {
        subsystems: {
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
              service: await loadEcommercePlugin(),
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

  const firstRuntime = await createZelavis({
    subsystems: {
      database: { directory },
    },
    serviceRegistry: {
      catalog: [
        {
          service: await loadEcommercePlugin(),
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
    subsystems: {
      database: { directory },
    },
    serviceRegistry: {
      catalog: [
        {
          service: await loadEcommercePlugin(),
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

  const uploadResponse = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/storage/files/uploads/hello.txt", {
      method: "PUT",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-zelavis-meta-origin": "test",
      },
      body: "hello world",
    }),
    PLATFORM_OWNER_CONTEXT,
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
    PLATFORM_OWNER_CONTEXT,
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
    PLATFORM_OWNER_CONTEXT,
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(files.has("uploads/hello.txt"), false);
});
