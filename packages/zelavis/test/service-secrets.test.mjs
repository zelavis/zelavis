import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createServiceSecrets } from "../dist/platform/service-secrets.js";

test("service secrets seal values and bind ciphertext to service and name", async () => {
  const store = createMemorySystemStore();
  const secrets = createServiceSecrets(store, "@acme/one", "master");
  const other = createServiceSecrets(store, "@acme/two", "master");
  await secrets.set("stripe.secret-key", "never-expose-this");
  assert.equal(await secrets.get("stripe.secret-key"), "never-expose-this");
  assert.equal(await other.get("stripe.secret-key"), undefined);
  assert.deepEqual(await secrets.list(), ["stripe.secret-key"]);
  const raw = await store.get("zelavis.service-secrets:@acme/one", "stripe.secret-key");
  assert.ok(!JSON.stringify(raw).includes("never-expose-this"));
  await store.set("zelavis.service-secrets:@acme/two", "stripe.secret-key", raw.value);
  await assert.rejects(other.get("stripe.secret-key"));
  await store.set("zelavis.service-secrets:@acme/one", "different", raw.value);
  await assert.rejects(secrets.get("different"));
  assert.equal(await secrets.delete("stripe.secret-key"), true);
  assert.equal(await secrets.get("stripe.secret-key"), undefined);
});

test("service secret names, byte bounds, corruption and concurrent limit are enforced", async () => {
  const store = createMemorySystemStore();
  const secrets = createServiceSecrets(store, "one", "master");
  const second = createServiceSecrets(store, "one", "master");
  await assert.rejects(secrets.set("../two", "value"));
  await assert.rejects(secrets.set("key", "é".repeat(2049)));
  await secrets.set("key", "é".repeat(2048));
  const results = await Promise.allSettled(Array.from({ length: 32 }, (_, i) => (i % 2 ? second : secrets).set(`key${i}`, "value")));
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  assert.equal((await secrets.list()).length, 32);
  await secrets.set("key", "replacement");
  assert.equal(await second.get("key"), "replacement");
  await store.set("zelavis.service-secrets:one", "key", { schemaVersion: 9 });
  await assert.rejects(secrets.get("key"));
});

test("service worker contributions start once and clean up before storage closes", async () => {
  const { zelavis } = await import("../dist/index.js");
  const events = [];
  const store = createMemorySystemStore();
  store.close = () => { events.push("store"); };
  const runtime = await zelavis({ systemStore: store, serviceRegistry: { catalog: [{ status: "installed", service: { name: "@test/worker", namespace: "worker", kind: "plugin", setup(context) {
    assert.ok(context.core.secrets);
    context.addRuntimePlugin(({ hooks }) => {
      hooks.hook("start", () => { events.push("start"); });
      return () => { events.push("stop"); };
    });
  } } }] } });
  assert.deepEqual(events, ["start"]);
  await runtime.close();
  await runtime.close();
  assert.deepEqual(events, ["start", "stop", "store"]);
});

test("a failed runtime start releases service workers before closing their store", async () => {
  const { zelavis } = await import("../dist/index.js");
  const events = [];
  const store = createMemorySystemStore();
  store.close = () => { events.push("store"); };
  await assert.rejects(zelavis({ systemStore: store, serviceRegistry: { catalog: [{ status: "installed", service: { name: "@test/failing-worker", namespace: "failingWorker", kind: "plugin", setup(context) {
    context.addRuntimePlugin(({ hooks }) => {
      hooks.hook("start", () => { events.push("start"); throw new Error("fixture start failure"); });
      return () => { events.push("stop"); };
    });
  } } }] } }), /fixture start failure/);
  assert.deepEqual(events, ["start", "stop", "store"]);
});
