import assert from "node:assert/strict";
import test from "node:test";
import { billing, checkout } from "./_billing.mjs";
import { createFulfillment } from "../dist/services/fulfillment.js";
async function paid(f, id = "paid") {
  const reference = (await checkout(f)).body.checkout.reference;
  const response = await f.runtime.fetch(new Request("http://localhost/zelavis/api/v1/plugins/ecommerce/webhooks/fake", { method: "POST", headers: { "content-type": "application/json", signature: "valid" }, body: JSON.stringify([{ type: "checkout.completed", eventId: id, occurredAt: new Date().toISOString(), checkoutReference: reference }]) }));
  assert.equal(response.status, 200);
}

test("fulfillment retries only the failing handler with backoff and keeps messages until both deliver", async t => {
  const f = await billing(t);
  let now = Date.now(), first = 0, second = 0;
  const delivery = createFulfillment(f.api.repositories.fulfillment, () => now);
  await f.api.runPromise(delivery.registerHandler("first", async message => { first++; assert.equal(message.id, "fake:paid"); }));
  await f.api.runPromise(delivery.registerHandler("second", async () => { second++; if (second < 3) throw new Error("temporary"); }));
  await paid(f);
  await f.api.runPromise(delivery.deliver());
  assert.equal(first, 1); assert.equal(second, 1);
  let failures = (await f.request("/fulfillment/failures")).body.deliveries;
  assert.equal(failures.length, 1); assert.equal(failures[0].attempts, 1);
  assert.equal(failures[0].nextAttemptAt, now + 30000);
  await f.api.runPromise(delivery.deliver());
  assert.equal(second, 1);
  now += 30000;
  await f.api.runPromise(delivery.deliver());
  assert.equal(second, 2); assert.equal(first, 1);
  now += 120000;
  await f.api.runPromise(delivery.deliver());
  assert.equal(second, 3); assert.equal(first, 1);
  assert.equal((await f.api.runPromise(f.api.repositories.fulfillment.read())).messages.length, 0);
  assert.equal((await f.request("/fulfillment/failures")).body.deliveries.length, 0);
});

test("committed fulfillment survives a runtime restart and the extension registers on its real API", async t => {
  const first = await billing(t);
  await paid(first);
  await first.runtime.close();
  const received = [];
  const handler = { name: "@test/fulfillment", namespace: "fulfiller", kind: "plugin", capabilities: ["@zelavis/ecommerce:fulfillment"], service: { register(api) { return api.runPromise(api.fulfillment.registerHandler("hosting", async message => { received.push(message); })); } } };
  const next = await billing(t, { directory: first.directory, handlers: [{ service: handler, status: "installed" }] });
  await next.api.runPromise(next.api.fulfillment.deliver());
  assert.equal(received.length, 1);
  assert.equal(received[0].id, "fake:paid");
  await next.api.runPromise(next.api.fulfillment.deliver());
  assert.equal(received.length, 1);
});

test("the runtime worker delivers a newly committed event without a manual delivery call", async t => {
  const { Effect } = await import("effect");
  const received = Promise.withResolvers();
  const handler = { name: "@test/automatic", namespace: "automatic", kind: "plugin", capabilities: ["@zelavis/ecommerce:fulfillment"], service: { register(api) { return api.runPromise(api.fulfillment.registerHandler("automatic", async message => { received.resolve(message); })); } } };
  const f = await billing(t, { handlers: [{ service: handler, status: "installed" }] });
  await paid(f, "automatic");
  const message = await Effect.runPromise(Effect.tryPromise(() => received.promise).pipe(Effect.timeout("8 seconds")));
  assert.equal(message.id, "fake:automatic");
});

test("timed-out handler promises still count toward the four-call bound", { timeout: 10000 }, async () => {
  const { Effect, Fiber } = await import("effect");
  const { TestClock } = await import("effect/testing");
  const { memoryFulfillment } = await import("../dist/repositories/memory-fulfillment.js");
  const pending = [];
  let calls = 0;
  const outbox = memoryFulfillment();
  outbox.emit("fake", { eventId: "slow", type: "checkout.completed", occurredAt: new Date() }, { id: "checkout" });
  const delivery = createFulfillment(outbox.repository, () => 1_000_000);
  try {
    await Effect.runPromise(Effect.gen(function* () {
      for (let i = 0; i < 5; i++) yield* delivery.registerHandler(`handler${i}`, () => { calls++; return new Promise(resolve => pending.push(resolve)); });
      const pass = yield* Effect.forkChild(delivery.deliver(), { startImmediately: true });
      yield* TestClock.adjust("31 seconds");
      yield* Fiber.join(pass);
      assert.equal(calls, 4);
      assert.equal((yield* delivery.failures()).deliveries.length, 4);
      yield* delivery.deliver();
      assert.equal(calls, 4);
      assert.equal((yield* outbox.repository.read()).messages.length, 1);
    }).pipe(Effect.provide(TestClock.layer())));
  } finally { for (const resolve of pending) resolve(); }
});

test("a removed handler leaves no orphaned failure after remaining handlers acknowledge", async t => {
  const first = await billing(t);
  await first.api.runPromise(first.api.fulfillment.registerHandler("kept", async () => {}));
  await first.api.runPromise(first.api.fulfillment.registerHandler("removed", async () => { throw new Error("removed handler"); }));
  await paid(first, "removed");
  await first.api.runPromise(first.api.fulfillment.deliver());
  assert.equal((await first.request("/fulfillment/failures")).body.deliveries.length, 1);
  await first.runtime.close();
  let calls = 0;
  const handler = { name: "@test/remaining", namespace: "remaining", kind: "plugin", capabilities: ["@zelavis/ecommerce:fulfillment"], service: { register(api) { return api.runPromise(api.fulfillment.registerHandler("kept", async () => { calls++; })); } } };
  const next = await billing(t, { directory: first.directory, handlers: [{ service: handler, status: "installed" }] });
  await next.api.runPromise(next.api.fulfillment.deliver());
  assert.equal(calls, 0);
  assert.equal((await next.request("/fulfillment/failures")).body.deliveries.length, 0);
  assert.equal((await next.api.runPromise(next.api.repositories.fulfillment.read())).messages.length, 0);
});
