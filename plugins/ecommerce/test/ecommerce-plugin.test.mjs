import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Zelavis,
} from "../../../packages/zelavis/dist/index.js";
import { loadEcommercePlugin } from "./load-plugin.mjs";

test("ecommercePlugin defines standard Zelavis plugin structure with OpenAPI specs", async () => {
  // Loaded rather than imported: the plugin declares its menu through
  // `zelavis.menu.create`, which only works inside a plugin execution context.
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
