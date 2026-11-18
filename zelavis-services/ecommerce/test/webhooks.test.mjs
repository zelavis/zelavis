import assert from "node:assert/strict";
import test from "node:test";
import { billing, checkout } from "./_billing.mjs";
const when = new Date("2026-11-17T12:00:00Z");
export const complete = (reference, id = "evt_completed") => ({ type: "checkout.completed", eventId: id, occurredAt: when.toISOString(), checkoutReference: reference, customerReference: "cus_provider", subscriptionReference: "sub_provider" });
export function webhook(f, events, signature = "valid") {
  return f.runtime.fetch(new Request("http://localhost/zelavis/api/v1/plugins/ecommerce/webhooks/fake", {
    method: "POST", headers: { "content-type": "application/json", signature }, body: JSON.stringify(events),
  }));
}

test("verified webhooks commit one state change and outbox message under concurrent duplicates", async t => {
  const f = await billing(t);
  const created = (await checkout(f)).body.checkout;
  const event = complete(created.reference);
  const bad = await webhook(f, [event], "wrong");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "invalid_webhook" });
  assert.equal((await f.request("/subscriptions")).body.length, 0);
  const copies = await Promise.all([webhook(f, [event]), webhook(f, [event])]);
  assert.deepEqual(copies.map(r => r.status), [200, 200]);
  assert.equal((await webhook(f, [event])).status, 200);
  const subscriptions = (await f.request("/subscriptions")).body;
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].status, "active");
  const tenant = f.runtime.database.forTenant("service:@zelavis/ecommerce");
  const messages = await tenant.outbox.read({ limit: 50 });
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0].id, "fake:evt_completed");
  assert.equal(messages.messages[0].payload.record.subscriptionId, subscriptions[0].id);
  const newer = { type: "subscription.updated", eventId: "evt_new", occurredAt: "2026-11-17T13:00:00Z", subscriptionReference: "sub_provider", status: "past_due", cancelAtPeriodEnd: false };
  const older = { ...newer, eventId: "evt_old", occurredAt: "2026-11-17T12:30:00Z", status: "active" };
  assert.equal((await webhook(f, [newer])).status, 200);
  assert.equal((await webhook(f, [older])).status, 200);
  assert.equal((await f.request("/subscriptions")).body[0].status, "past_due");
  assert.equal((await webhook(f, [complete("unknown", "evt_unknown")])).status, 200);
  assert.equal((await tenant.outbox.read({ limit: 50 })).messages.length, 2);
});

test("webhook body and event bounds refuse work without applying state", async t => {
  const f = await billing(t);
  const created = (await checkout(f)).body.checkout;
  assert.equal((await webhook(f, Array(21).fill(complete(created.reference)))).status, 400);
  const huge = await f.runtime.fetch(new Request("http://localhost/zelavis/api/v1/plugins/ecommerce/webhooks/fake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(262145) }) }));
  assert.ok([400, 413].includes(huge.status));
  assert.equal((await f.request("/subscriptions")).body.length, 0);
});

test("a hosted native App accepts its signed service callback through public ingress", async t => {
  const { forwardProjectSiteRequest } = await import("../../../packages/zelavis/dist/platform/public-domain-forwarder.js");
  const { publicRequestFromPrivateAuth } = await import("../../../packages/zelavis/dist/platform/project-public-auth.js");
  const f = await billing(t);
  const reference = (await checkout(f)).body.checkout.reference;
  const options = { rootPath: "/zelavis", projects: { listOwned: async () => [] }, project: { id: "app", recipe: { name: "@zelavis/app" }, runtime: { status: "running", url: "http://127.0.0.1:45678" } }, fetchSite: (url, init) => {
    const request = publicRequestFromPrivateAuth(new Request(url, init));
    assert.ok(request);
    return f.runtime.fetch(request);
  } };
  const request = signature => new Request("https://app.example/zelavis/api/v1/plugins/ecommerce/webhooks/fake", { method: "POST", headers: { "content-type": "application/json", signature }, body: JSON.stringify([complete(reference)]) });
  assert.equal((await forwardProjectSiteRequest(options, request("wrong"))).status, 400);
  assert.equal((await forwardProjectSiteRequest(options, request("valid"))).status, 200);
  assert.equal((await f.request("/subscriptions")).body.length, 1);
});

test("recurring invoice events create one linked payment and apply updates in provider order", async t => {
  const f = await billing(t);
  const reference = (await checkout(f)).body.checkout.reference;
  await webhook(f, [complete(reference)]);
  const invoice = { type: "payment.failed", eventId: "invoice_failed", occurredAt: "2026-11-17T14:00:00Z", paymentReference: "in_month2", subscriptionReference: "sub_provider", amount: 1200, currency: "USD" };
  assert.deepEqual((await Promise.all([webhook(f, [invoice]), webhook(f, [invoice])])).map(result => result.status), [200, 200]);
  const paid = { ...invoice, eventId: "invoice_paid", type: "payment.succeeded", occurredAt: "2026-11-17T15:00:00Z" };
  assert.equal((await webhook(f, [paid])).status, 200);
  assert.equal((await webhook(f, [{ ...invoice, eventId: "older_failure" }])).status, 200);
  const attempts = (await f.request("/payments/attempts")).body;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, "captured");
  assert.equal(attempts[0].reference, "in_month2");
  assert.equal(attempts[0].subscriptionId, (await f.request("/subscriptions")).body[0].id);
  assert.equal((await webhook(f, [{ ...invoice, eventId: "unknown_invoice", paymentReference: "in_unknown", subscriptionReference: "sub_unknown" }])).status, 200);
  assert.equal((await f.request("/payments/attempts")).body.length, 1);
});
