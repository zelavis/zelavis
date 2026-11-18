import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../../../packages/zelavis/dist/index.js";
import { loadPluginPackage } from "../../../packages/zelavis/dist/service.js";
import { resolveLocalPackageManifest } from "../../../packages/zelavis/dist/adapters/_local-runtime.js";
import { loadEcommercePlugin } from "./load-plugin.mjs";
import { createZelavisClient } from "../../../packages/zelavis/dist/sdk/fetch.js";
const owner = { id: "owner", type: "user", permissions: ["*"] };

async function platform(t, stripe) {
  const store = createMemorySystemStore();
  const runtime = await zelavis({ systemStore: store, serviceRegistry: { catalog: [{ service: await loadEcommercePlugin(), status: "installed" }, { service: stripe, status: "installed" }] } });
  t.after(() => runtime.close());
  const request = (method, body, principal = owner) => runtime.plain({ url: "/zelavis/api/v1/plugins/stripe/settings", method, body, principal });
  return { store, runtime, request };
}

test("installed Stripe loads its manifest and keeps credentials sealed and runtime-local", async t => {
  const stripe = await loadPluginPackage({ manifest: resolveLocalPackageManifest(new URL("../plugins/stripe", import.meta.url).pathname), importer: () => import("../plugins/stripe/dist/index.js") });
  const first = await platform(t, stripe), second = await platform(t, stripe);
  assert.equal((await first.runtime.plain({ url: "/zelavis/api/v1/plugins/stripe/settings" })).status, 401);
  assert.equal((await first.request("GET", undefined, { id: "viewer", type: "user", permissions: ["ecommerce.view"] })).status, 403);
  const saved = await first.request("PUT", { secretKey: "sk_test_private1234", webhookSecret: "whsec_private5678" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { configured: { secretKey: true, webhookSecret: true }, secretKeyHint: "…1234" });
  assert.ok(!JSON.stringify(await first.store.list("zelavis.service-secrets:@zelavis/ecommerce-stripe")).includes("private"));
  assert.deepEqual((await second.request("GET")).body.configured, { secretKey: false, webhookSecret: false });
  const { createRequire } = await import("node:module");
  const Stripe = createRequire(new URL("../plugins/stripe/package.json", import.meta.url))("stripe");
  const signer = new Stripe("sk_test_fixture");
  const payload = JSON.stringify({ id: "evt_credentials", type: "unhandled", created: Math.floor(Date.now()/1000), data: { object: {} } });
  const headers = { "content-type": "application/json", "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_private5678" }) };
  const callback = () => new Request("http://localhost/zelavis/api/v1/plugins/ecommerce/webhooks/stripe", { method: "POST", headers, body: payload });
  assert.equal((await first.runtime.fetch(callback())).status, 200);
  assert.equal((await second.runtime.fetch(callback())).status, 409);

  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => first.runtime.fetch(new Request(url, init), { principal: owner }) });
  assert.equal((await client.plugins.stripe.settings.get()).secretKeyHint, "…1234");
  assert.equal((await client.plugins.stripe.settings.set({ webhookSecret: "" })).configured.webhookSecret, false);
  assert.equal((await first.request("PUT", { secretKey: "bad-key" })).status, 400);
  await second.runtime.plain({ url: "/zelavis/api/v1/plugins/ecommerce/customers", method: "POST", principal: owner, body: { id: "customer", email: "user@example.com" } });
  const noKey = await second.runtime.plain({ url: "/zelavis/api/v1/plugins/ecommerce/checkouts", method: "POST", principal: owner, body: { provider: "stripe", customerId: "customer", mode: "payment", lines: [{ name: "Test", amount: 1, currency: "USD", quantity: 1 }], successUrl: "https://shop.example", cancelUrl: "https://shop.example" } });
  assert.equal(noKey.status, 409, JSON.stringify(noKey.body));
  assert.ok(!JSON.stringify(noKey.body).includes("private"));
});
