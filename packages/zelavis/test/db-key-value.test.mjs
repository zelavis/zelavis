import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Schema } from "effect";
import { KeyValueStore } from "effect/unstable/persistence/KeyValueStore";
import {
  effectKeyValueStoreLayer,
  makeDatabase,
  partitionMapFor,
  toEffectKeyValueStore,
} from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";

const withTenant = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stores = new Map();
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1"]),
      openShard: (shard) => {
        let store = stores.get(shard);
        if (store === undefined) {
          store = makeMemoryStore(shard);
          stores.set(shard, store);
        }
        return store;
      },
    });
    return yield* body(db.forTenant("acme"));
  })));

test("key/value is a lens over the same multimodal document payload", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({
      name: "products",
      analyzer: { fields: ["title"], version: 1 },
      measures: [{ name: "price", path: "price" }],
    });
    assert.deepEqual(yield* tenant.documents.modalities({ collection: "products" }), {
      collection: "products",
      document: { status: "ready" },
      keyValue: { status: "ready", key: "document.id" },
      events: { status: "ready" },
      columns: { status: "ready", fields: "all-json-scalars" },
      search: { status: "ready", fields: ["title"] },
      measures: { status: "ready", fields: ["price"] },
      graph: { status: "requires-declaration", edges: [] },
      spatial: { status: "requires-declaration", fields: [] },
      vector: { status: "requires-declaration" },
    });
    const products = tenant.kv.namespace("products");

    const created = yield* products.set("p1", { title: "Red Bicycle", price: 120 });
    assert.equal(created.version, 1);
    assert.deepEqual((yield* tenant.documents.findById({ collection: "products", id: "p1" })).data,
      { title: "Red Bicycle", price: 120 });
    assert.deepEqual(
      (yield* tenant.documents.findMany({ collection: "products", search: "bicycle" })).map((doc) => doc.id),
      ["p1"],
    );
    assert.deepEqual(yield* tenant.documents.summarize({
      collection: "products", measure: "price", op: "sum",
    }), { value: 120, documents: 1 });

    yield* tenant.documents.update({
      collection: "products", id: "p1", data: { price: 125 },
    });
    assert.equal((yield* products.get("p1")).value.price, 125, "document writes are immediately visible as KV");
  })));

test("key/value supports CAS, insert-only writes, atomic batches, and scans", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "settings" });
    const settings = tenant.kv.namespace("settings");

    const first = yield* settings.set("app/theme", { mode: "dark" }, { ifAbsent: true });
    const duplicate = yield* Effect.flip(settings.set("app/theme", { mode: "light" }, { ifAbsent: true }));
    assert.equal(duplicate._tag, "DocumentConflict");
    const stale = yield* Effect.flip(settings.set("app/theme", { mode: "light" }, { expectedVersion: 99 }));
    assert.equal(stale._tag, "DocumentConflict");
    assert.equal((yield* settings.set("app/theme", { mode: "light" }, {
      expectedVersion: first.version,
    })).version, 2);

    yield* settings.write([
      { _tag: "Set", key: "app/locale", value: { locale: "en" } },
      { _tag: "Set", key: "user/name", value: { name: "Ada" } },
    ]);
    const refused = yield* Effect.flip(settings.write([
      { _tag: "Set", key: "app/locale", value: { locale: "de" }, expectedVersion: 99 },
      { _tag: "Remove", key: "app/theme" },
    ]));
    assert.equal(refused._tag, "DocumentConflict");
    assert.equal((yield* settings.get("app/theme")).value.mode, "light", "the failed batch changed nothing");

    const page = yield* settings.scan({ prefix: "app/", limit: 10 });
    assert.deepEqual(new Set(page.entries.map((entry) => entry.key)), new Set(["app/theme", "app/locale"]));
  })));

test("Effect KeyValueStore uses Zelavis storage and atomic modify", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "effect_cache" });
    const store = toEffectKeyValueStore(tenant.kv.namespace("effect_cache"));

    yield* store.set("count", "0");
    yield* Effect.forEach(
      Array.from({ length: 20 }),
      () => store.modify("count", (value) => String(Number(value) + 1)),
      { concurrency: "unbounded", discard: true },
    );
    assert.equal(yield* store.get("count"), "20");

    const bytes = new Uint8Array([0, 42, 255]);
    yield* store.set("bytes", bytes);
    assert.deepEqual(yield* store.getUint8Array("bytes"), bytes);
    assert.deepEqual(
      (yield* tenant.documents.findById({ collection: "effect_cache", id: "bytes" })).data,
      { encoding: "base64", value: "ACr/" },
      "binary values stay visible to every JSON/document projection through a typed envelope",
    );
    assert.equal(yield* store.size, 2);

    const fromLayer = yield* Effect.gen(function* () {
      const provided = yield* KeyValueStore;
      return yield* provided.get("count");
    }).pipe(Effect.provide(effectKeyValueStoreLayer(tenant.kv.namespace("effect_cache"))));
    assert.equal(fromLayer, "20");
  })));

test("key scans are lexicographic, ranged, directional, and cursor-stable", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "ordered" });
    const values = tenant.kv.namespace("ordered");
    for (const key of ["z", "app/z", "app/a", "b", "app/m"]) {
      yield* values.set(key, { key });
    }

    const first = yield* values.scan({ prefix: "app/", limit: 2 });
    assert.deepEqual(first.entries.map((entry) => entry.key), ["app/a", "app/m"]);
    assert.ok(first.next);
    const second = yield* values.scan({ prefix: "app/", limit: 2, after: first.next });
    assert.deepEqual(second.entries.map((entry) => entry.key), ["app/z"]);
    assert.equal(second.next, undefined);

    const descending = yield* values.scan({ lower: "b", upper: "z", direction: "desc" });
    assert.deepEqual(descending.entries.map((entry) => entry.key), ["b"]);
    const mismatch = yield* Effect.flip(values.scan({ prefix: "other/", after: first.next }));
    assert.equal(mismatch._tag, "KeyValueCursorMismatch");
  })));

test("TTL deletion is multimodal and appears in the resumable change feed", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({
      name: "sessions",
      analyzer: { fields: ["label"], version: 1 },
    });
    const sessions = tenant.kv.namespace("sessions");
    yield* sessions.set("active", { label: "keep" });
    const leased = yield* sessions.set("leased", { label: "lease" }, {
      ttlMs: 60_000, idempotencyKey: "lease-once",
    });
    const retried = yield* sessions.set("leased", { label: "lease" }, {
      ttlMs: 60_000, idempotencyKey: "lease-once",
    });
    assert.equal(retried.version, leased.version);
    assert.equal(retried.expiresAt, leased.expiresAt, "a TTL retry keeps the first absolute expiry");
    const expiring = yield* sessions.set("expired", { label: "discard" }, {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    assert.equal(expiring.expiresAt, "2000-01-01T00:00:00.000Z");
    const beforeDelete = (yield* sessions.changes()).at(-1).cursor;

    assert.equal(yield* sessions.get("expired"), undefined);
    assert.equal(yield* tenant.documents.findById({ collection: "sessions", id: "expired" }), undefined);
    assert.deepEqual(
      (yield* tenant.documents.findMany({ collection: "sessions", search: "discard" })).map((doc) => doc.id),
      [],
    );
    assert.equal(yield* sessions.size, 2);
    assert.deepEqual((yield* sessions.changes({ after: beforeDelete })).map((change) => ({
      key: change.key, type: change.type,
    })), [{ key: "expired", type: "remove" }]);
  })));

test("Effect Schema provides a typed view without creating a second store", () =>
  withTenant((tenant) => Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "typed" });
    const raw = tenant.kv.namespace("typed");
    const typed = raw.schema(Schema.Struct({ enabled: Schema.Boolean, count: Schema.Number }));

    yield* typed.set("feature", { enabled: true, count: 2 });
    assert.deepEqual((yield* typed.get("feature")).value, { enabled: true, count: 2 });
    assert.deepEqual((yield* tenant.documents.findById({ collection: "typed", id: "feature" })).data,
      { enabled: true, count: 2 });

    yield* raw.set("invalid", { enabled: "yes", count: 2 });
    const failure = yield* Effect.flip(typed.get("invalid"));
    assert.equal(failure._tag, "SchemaError");
  })));
