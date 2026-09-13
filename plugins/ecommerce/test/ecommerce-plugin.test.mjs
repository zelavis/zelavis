import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Zelavis,
} from "../../../packages/zelavis/dist/index.js";
import { createZelavisClient } from "../../../packages/zelavis/dist/sdk/fetch.js";
import { runPluginsCommand } from "../../../packages/zelavis/dist/cli/plugins.js";
import { loadEcommercePlugin } from "./load-plugin.mjs";

test("ecommercePlugin defines standard Zelavis plugin structure with OpenAPI specs", async () => {
  // Loaded rather than imported: the plugin declares its menu through
  // `zelavis.plugins.ui.menus.create`, which only works inside a plugin execution context.
  const ecommercePlugin = await loadEcommercePlugin();
  assert.equal(ecommercePlugin.name, "@zelavis/ecommerce");
  assert.equal(ecommercePlugin.kind, "plugin");
  assert.deepEqual(ecommercePlugin.capabilities, ["api:routes", "dashboard:menu"]);
  // The menu the SDK contributed reaches the loaded service.
  assert.equal(ecommercePlugin.menu.title, "Ecommerce");
});

test("ecommercePlugin registers and exposes recurring subscription endpoints", async (t) => {
  const dummyStripeProvider = {
    name: "@zelavis/ecommerce-stripe-test",
    kind: "provider",
    capabilities: ["@zelavis/ecommerce:payments"],
    service: {
      name: "stripe-test",
      register(api) {
        api.payments.registerProvider("stripe-test", {
          async createPayment(input) {
            return {
              id: "pay_test_1",
              orderId: input.order.id,
              provider: "stripe-test",
              amount: input.amount,
              currency: input.currency,
              status: "captured",
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
          async createSubscription(input) {
            return {
              id: "sub_test_1",
              customerId: input.customerId,
              provider: "stripe-test",
              amount: input.amount,
              currency: input.currency,
              interval: input.interval,
              intervalCount: input.intervalCount ?? 1,
              status: "active",
              cancelAtPeriodEnd: false,
              reference: "sub_stripe_ref_1",
              metadata: input.metadata,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
          async cancelSubscription(input) {
            return {
              ...input.subscription,
              status: "cancelled",
              cancelAtPeriodEnd: true,
              updatedAt: new Date(),
            };
          },
        });
      },
    },
  };

  const directory = mkdtempSync(join(tmpdir(), "zv-ecommerce-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const zelavis = new Zelavis({
    adapter: {
      name: "ecommerce-test-adapter",
      async resolve() {
        return {
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
              {
                service: dummyStripeProvider,
                status: "installed",
                source: "official",
                order: 1,
              },
            ],
            store: {
              read() {
                return [
                  { name: "@zelavis/ecommerce", status: "installed", order: 0 },
                  { name: "@zelavis/ecommerce-stripe-test", status: "installed", order: 1 },
                ];
              },
              write(entries) {
                return entries;
              },
            },
          },
        };
      },
    },
  });

  // Create customer
  const customerRes = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/customers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cus_sub_test",
        email: "subscriber@example.com",
        firstName: "Ada",
      }),
    }),
  );
  assert.equal(customerRes.status, 201);

  // Create subscription via POST /subscriptions
  const createSubRes = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: "cus_sub_test",
        provider: "stripe-test",
        amount: 2500,
        currency: "USD",
        interval: "month",
        intervalCount: 1,
        referenceId: "ref_sub_123",
        metadata: { tier: "pro" },
      }),
    }),
  );
  assert.equal(createSubRes.status, 201);
  const createdSub = await createSubRes.json();
  assert.equal(createdSub.id, "sub_test_1");
  assert.equal(createdSub.amount, 2500);
  assert.equal(createdSub.interval, "month");
  assert.equal(createdSub.status, "active");

  // Get subscription by ID via GET /subscriptions/:id
  const getSubRes = await zelavis.fetch(
    new Request(`http://localhost/zelavis/api/v1/commerce/subscriptions/${createdSub.id}`),
  );
  assert.equal(getSubRes.status, 200);
  const retrievedSub = await getSubRes.json();
  assert.equal(retrievedSub.id, createdSub.id);
  assert.equal(retrievedSub.customerId, "cus_sub_test");

  // List subscriptions via GET /subscriptions
  const listSubsRes = await zelavis.fetch(
    new Request("http://localhost/zelavis/api/v1/commerce/subscriptions"),
  );
  assert.equal(listSubsRes.status, 200);
  const listedSubs = await listSubsRes.json();
  assert.equal(listedSubs.length, 1);
  assert.equal(listedSubs[0].id, createdSub.id);

  // Cancel subscription via POST /subscriptions/:id/cancel
  const cancelSubRes = await zelavis.fetch(
    new Request(`http://localhost/zelavis/api/v1/commerce/subscriptions/${createdSub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Customer requested cancellation",
      }),
    }),
  );
  assert.equal(cancelSubRes.status, 200);
  const cancelledSub = await cancelSubRes.json();
  assert.equal(cancelledSub.status, "cancelled");
  assert.equal(cancelledSub.cancelAtPeriodEnd, true);

  // Asked of the runtime rather than of a second database handle: opening the
  // same shards again would claim the next writer generation and fence the
  // runtime that is still running.
  const collectionsResponse = await zelavis.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/database/documents/collections" +
        `?tenantId=${encodeURIComponent("service:@zelavis/ecommerce")}`,
    ),
  );
  assert.equal(collectionsResponse.status, 200);
  const { collections } = await collectionsResponse.json();
  const subCollection = collections.find((col) => col.name === "commerce_subscriptions");
  assert.ok(subCollection, "commerce_subscriptions collection should exist");
  assert.equal(subCollection.surface, "database", "surface must be 'database', not hidden in metadata");
});

test("ecommerce operations provide three-way parity across HTTP, JS SDK, and CLI", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zv-ecommerce-parity-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const plugin = await loadEcommercePlugin();
  const zelavis = new Zelavis({
    adapter: {
      name: "ecommerce-parity-adapter",
      async resolve() {
        return {
          subsystems: { database: { directory } },
          serviceRegistry: {
            catalog: [{ service: plugin, status: "installed", order: 0 }],
            store: {
              read() { return [{ name: "@zelavis/ecommerce", status: "installed", order: 0 }]; },
              write(entries) { return entries; },
            },
          },
        };
      },
    },
  });

  const owner = { principal: { id: "owner", type: "user", permissions: ["*"] } };
  const fetcher = (url, init) => zelavis.fetch(new Request(url, init), owner);
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: fetcher });

  // 1. Discover operations
  const operations = await client.pluginOperations();
  const ecommerceOps = operations.filter((op) => op.namespace === "ecommerce");
  assert.ok(ecommerceOps.length >= 18, `Expected at least 18 operations, got ${ecommerceOps.length}`);
  const productCreateOp = ecommerceOps.find((op) => op.resource === "products" && op.action === "create");
  assert.ok(productCreateOp, "products.create operation must exist");
  assert.equal(productCreateOp.path, "/plugins/ecommerce/products");

  // 2. HTTP access under /zelavis/api/v1/plugins/ecommerce/products
  const productInput = {
    title: "Vintage Denim Jacket",
    price: { amount: 8900, currency: "USD" },
    slug: "vintage-denim-jacket",
  };
  const httpRes = await fetcher("http://localhost/zelavis/api/v1/plugins/ecommerce/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(productInput),
  });
  assert.equal(httpRes.status, 201);
  const createdProduct = await httpRes.json();
  assert.equal(createdProduct.title, "Vintage Denim Jacket");

  // 3. JS SDK client access via client.plugins.ecommerce.products
  const sdkProducts = await client.plugins.ecommerce.products.list();
  assert.equal(sdkProducts.length, 1);
  assert.equal(sdkProducts[0].title, "Vintage Denim Jacket");

  const productById = await client.plugins.ecommerce.products.getById(undefined, {
    params: { id: createdProduct.id },
  });
  assert.equal(productById.id, createdProduct.id);

  // 4. CLI access via runPluginsCommand with --data inline JSON
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = fetcher;
  console.log = (value) => output.push(value);
  try {
    await runPluginsCommand([
      "ecommerce",
      "products",
      "create",
      `--data=${JSON.stringify({ title: "Corduroy Cap", price: { amount: 2500, currency: "USD" } })}`,
      "--url=http://localhost/zelavis",
    ]);
    const cliCreated = JSON.parse(output.pop());
    assert.equal(cliCreated.title, "Corduroy Cap");

    await runPluginsCommand(["ecommerce", "products", "list", "--url=http://localhost/zelavis"]);
    const cliList = JSON.parse(output.pop());
    assert.equal(cliList.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
