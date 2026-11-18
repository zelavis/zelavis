import assert from "node:assert/strict";
import test from "node:test";
import { billing, checkout, line, owner } from "./_billing.mjs";
import { createZelavisClient } from "../../../packages/zelavis/dist/sdk/fetch.js";
import { runPluginsCommand } from "../../../packages/zelavis/dist/cli/plugins.js";

test("checkout and portal persist customer identity and expose HTTP, SDK and CLI operations", async t => {
  const f = await billing(t);
  const created = await checkout(f);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const value = created.body.checkout;
  assert.equal(value.metadata.plan, "hosting");
  assert.equal((await f.request(`/checkouts/${value.id}`)).body.checkout.reference, value.reference);
  const customer = (await f.request("/customers/customer")).body;
  assert.equal(customer.principalId, "user");
  assert.equal(customer.providerReferences.fake, "cus_provider");
  assert.equal((await f.request("/customers/customer/portal", "POST", { provider: "fake", returnUrl: "https://shop.example" })).body.url, "https://billing.example/cus_provider");
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => f.runtime.fetch(new Request(url, init), { principal: owner }) });
  assert.equal((await client.plugins.ecommerce.checkouts.get(undefined, { params: { id: value.id } })).checkout.id, value.id);
  const output = [];
  const previousFetch = globalThis.fetch, previousLog = console.log;
  globalThis.fetch = (url, init) => f.runtime.fetch(new Request(url, init), { principal: owner });
  console.log = text => output.push(text);
  try { await runPluginsCommand(["ecommerce", "checkouts", "get", "--param", `id=${value.id}`, "--url", "http://localhost/zelavis", "--json"]); }
  finally { globalThis.fetch = previousFetch; console.log = previousLog; }
  assert.ok(output.join("").includes(value.id));
});

test("checkout rejects invalid inputs and unsupported providers without creating a session", async t => {
  let calls = 0;
  const f = await billing(t, { provider: { createCheckout: async () => { calls++; return { reference: "x", url: "https://checkout.example" }; } } });
  await checkout(f);
  const input = { provider: "fake", customerId: "customer", mode: "subscription", lines: [line], successUrl: "https://shop.example", cancelUrl: "https://shop.example" };
  for (const change of [{ lines: [] }, { lines: Array(21).fill(line) }, { successUrl: "http://evil.example" }, { lines: [{ ...line, amount: -1 }] }, { metadata: { bad: 7 } }]) {
    assert.equal((await f.request("/checkouts", "POST", { ...input, ...change })).status, 400);
  }
  assert.equal(calls, 1);
  await f.api.runPromise(f.api.payments.registerProvider("old", { createPayment: async () => {} }));
  assert.equal((await f.request("/checkouts", "POST", { ...input, provider: "old" })).status, 409);
});

test("checkout rejects unsafe totals and malformed portal requests before provider calls", async t => {
  const f = await billing(t);
  await checkout(f);
  assert.equal((await f.request("/customers/customer/portal", "POST", {})).status, 400);
  assert.equal((await f.request("/customers/customer/portal", "POST", { provider: "fake" })).status, 400);
  const result = await f.request("/checkouts", "POST", { provider: "fake", customerId: "customer", mode: "subscription", lines: [{ ...line, amount: Number.MAX_SAFE_INTEGER }, { ...line, amount: Number.MAX_SAFE_INTEGER }], successUrl: "https://shop.example", cancelUrl: "https://shop.example" });
  assert.equal(result.status, 400);
});

test("concurrent provider references merge without replacing another provider's customer identity", async t => {
  const f = await billing(t);
  await checkout(f);
  await f.api.runPromise(f.api.payments.registerProvider("second", { ...f.provider, createCheckout: async input => ({ reference: `other_${input.checkoutId}`, url: "https://checkout.example/session", customerReference: "cus_second" }) }));
  const input = { customerId: "customer", mode: "subscription", lines: [line], successUrl: "https://shop.example", cancelUrl: "https://shop.example" };
  const responses = await Promise.all([f.request("/checkouts", "POST", { ...input, provider: "fake" }), f.request("/checkouts", "POST", { ...input, provider: "second" })]);
  assert.deepEqual(responses.map(value => value.status), [201, 201]);
  assert.deepEqual((await f.request("/customers/customer")).body.providerReferences, { fake: "cus_provider", second: "cus_second" });
});

test("provider exception details never reach API responses or the generic error log", async t => {
  const { setUnexpectedErrorSink } = await import("../../../packages/zelavis/dist/core/runtime/error-policy.js");
  const leaked = [];
  const f = await billing(t, { provider: { createCheckout: async () => { throw new Error("sk_test_sensitive whsec_sensitive"); } } });
  setUnexpectedErrorSink((_id, error) => leaked.push(String(error)));
  try {
    const response = await checkout(f);
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: "provider_failure" });
    assert.deepEqual(leaked, []);
  } finally { setUnexpectedErrorSink(undefined); }
});

test("invalid persisted checkout and customer-reference fields fail as typed storage errors", async t => {
  const f = await billing(t);
  const created = (await checkout(f)).body.checkout;
  const tenant = f.runtime.database.forTenant("service:@zelavis/ecommerce");
  await tenant.documents.update({ collection: "commerce_checkouts", id: created.id, data: { lines: [{ ...line, quantity: -1 }] } });
  await assert.rejects(f.api.runPromise(f.api.checkouts.get(created.id)), error => error._tag === "StorageFailure");
  await tenant.documents.update({ collection: "commerce_customers", id: "customer", data: { providerReferences: { fake: 42 } } });
  await assert.rejects(f.api.runPromise(f.api.customers.getById("customer")), error => error._tag === "StorageFailure");
});
