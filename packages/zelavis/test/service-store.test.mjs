import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemorySystemStore,
  createServiceStore,
  serviceStoreNamespace,
} from "../dist/index.js";

test("a service store keeps one service's records to itself", async () => {
  const systemStore = createMemorySystemStore();
  const first = createServiceStore(systemStore, "@acme/one");
  const second = createServiceStore(systemStore, "@acme/two");

  await first.set("secret", { value: "one" });
  await second.set("secret", { value: "two" });

  // Same key, different services: a plugin must not be able to read or
  // overwrite another one's state by guessing a key name.
  assert.deepEqual(await first.get("secret"), { value: "one" });
  assert.deepEqual(await second.get("secret"), { value: "two" });
  assert.equal((await first.list()).length, 1);
});

test("a service cannot reach the Platform's own namespaces", () => {
  // The namespace is derived from the registry's name for the service, and
  // carries a prefix no Platform namespace uses.
  assert.equal(serviceStoreNamespace("@acme/one"), "zelavis.service:@acme/one");
  assert.ok(serviceStoreNamespace("zelavis.platform").startsWith("zelavis.service:"));
  assert.throws(() => serviceStoreNamespace("  "), /service name is required/u);
});

test("names are not collapsed into a shared namespace", () => {
  // Two services whose names normalized to the same thing would silently
  // share state, so the name goes in whole.
  assert.notEqual(
    serviceStoreNamespace("@acme/one-two"),
    serviceStoreNamespace("@acme/one_two"),
  );
});

test("deleting removes only that service's record", async () => {
  const systemStore = createMemorySystemStore();
  const first = createServiceStore(systemStore, "@acme/one");
  const second = createServiceStore(systemStore, "@acme/two");
  await first.set("k", { a: 1 });
  await second.set("k", { a: 2 });

  assert.equal(await first.delete("k"), true);
  assert.equal(await first.get("k"), undefined);
  assert.deepEqual(await second.get("k"), { a: 2 });
});
