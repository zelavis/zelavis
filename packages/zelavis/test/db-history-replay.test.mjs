import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { CARRY_COLLECTION, REPLAY_HISTORY } from "../dist/db/document-writes.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { openTemporaryDatabase } from "./_database.mjs";

const enc = (text) => new TextEncoder().encode(text);
const emptyManifest = { terms: [], columns: [], measures: [], edges: [] };

const withStore = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-stamp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const store = (yield* makeNodeSqliteStore("acme", dir)).partition("acme");
      return yield* body(store);
    })),
  );
};

const run = Effect.runPromise;
const feed = async (tenant) => (await run(tenant.events.read({ limit: 1000 }))).events;
const documentFeed = async (tenant) => (await feed(tenant)).filter((event) => event.documentId !== undefined);
const failed = async (effect) => { const exit = await Effect.runPromiseExit(effect); assert.ok(Exit.isFailure(exit)); return exit; };
const tagOf = (exit) => Cause.squash(exit.cause)._tag;
const dies = async (effect, what) => assert.ok(Cause.hasDies((await failed(effect)).cause), `${what} is a defect`);
const iso = (ms) => new Date(ms).toISOString();
const put = (collection, id, data, version, at, extra = {}) => ({ _tag: "Put", collection, id, data, version, createdAt: iso(at), updatedAt: iso(at), at, ...extra });
const retract = (collection, id, at) => ({ _tag: "Retract", collection, id, at });
const replay = (documents, changes) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes } });
const settle = (documents, collection, ids) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Settle", collection, ids } });
const ids = (found) => found.map((document) => document.id).sort();

const USERS = {
  name: "users",
  indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }],
  checks: [{ name: "adult", where: [{ path: "age", op: "gte", value: 18 }] }],
};
const POSTS = { name: "posts", edges: [{ name: "wrote", path: "author", collection: "users" }] };
const COMMENTS = { name: "comments", references: [{ name: "post", path: "post", collection: "posts", onDelete: "cascade" }] };

/** A history the final constraints would have refused on the way: u1 too young, then u2 sharing u1's email. */
const R1_HISTORY = [
  put("users", "u1", { email: "a", age: 10 }, 1, 1000),
  put("users", "u2", { email: "a", age: 30 }, 1, 1100),
  put("users", "u2", { email: "b", age: 30 }, 2, 1200),
  put("users", "u1", { email: "a", age: 30 }, 2, 1300),
  put("users", "u1", { email: "a", age: 30 }, 2, 1350),
  retract("users", "u2", 1400),
  put("users", "u2", { email: "c", age: 40 }, 1, 1500),
  put("posts", "p1", { author: "u1" }, 1, 1600),
];

const tenantOf = async (t) => (await openTemporaryDatabase(t)).database.forTenant("tenant-a");

const storeEvents = (store) => Effect.map(Stream.runCollect(store.events.read({ limit: 100 })), (events) => [...events]);

test("an event is stamped when its write was accepted", (t) =>
  withStore(t, (store) =>
    Effect.gen(function* () {
      const before = Date.now();
      yield* store.transact((txn) =>
        Effect.gen(function* () {
          const seq = yield* txn.allocate;
          yield* txn.put(seq, enc("a"), emptyManifest, { namespace: "n", key: "k" });
        }));
      const events = yield* storeEvents(store);
      assert.equal(events.length, 1);
      assert.ok(events[0].at >= before && events[0].at <= Date.now(), "the event's time is when it was written");
    })));

test("stampedAt stamps puts and retractions, and refuses a bad time", (t) =>
  withStore(t, (store) =>
    Effect.gen(function* () {
      const seq = yield* store.transact((txn) =>
        Effect.gen(function* () {
          const allocated = yield* txn.allocate;
          yield* txn.stampedAt(1234).put(allocated, enc("a"), emptyManifest, { namespace: "n", key: "k" });
          return allocated;
        }));
      yield* store.transact((txn) => txn.stampedAt(5678).retract(seq));
      const events = yield* storeEvents(store);
      assert.deepEqual(events.map((event) => event.at), [1234, 5678]);
      assert.deepEqual(events.map((event) => event._tag), ["ObjectPut", "ObjectRetracted"]);

      for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        const put = yield* Effect.exit(store.transact((txn) =>
          Effect.gen(function* () {
            const allocated = yield* txn.allocate;
            yield* txn.stampedAt(bad).put(allocated, enc("b"), emptyManifest, { namespace: "n", key: `bad-${bad}` });
          })));
        assert.ok(Exit.isFailure(put) && Cause.hasDies(put.cause), `a put stamped ${bad} is a defect`);
        // Even a retraction of nothing live: a bad time never passes silently.
        const retracted = yield* Effect.exit(store.transact((txn) => txn.stampedAt(bad).retract(seq)));
        assert.ok(Exit.isFailure(retracted) && Cause.hasDies(retracted.cause), `a retraction stamped ${bad} is a defect`);
      }
      assert.equal((yield* storeEvents(store)).length, 2, "nothing a refused stamp wrote remains");
    })));

test("a carried collection keeps its creation time, and its events and its targets' carry the event time", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "posts", [CARRY_COLLECTION]: { createdAt: "2026-01-02T03:04:05.000Z", at: 1000 } }));
  await run(documents.createCollection({ ...COMMENTS, [CARRY_COLLECTION]: { createdAt: "2026-01-03T00:00:00.000Z", at: 1000 } }));
  const collections = await run(documents.listCollections);
  assert.equal(collections.find((collection) => collection.name === "posts").createdAt, "2026-01-02T03:04:05.000Z");
  assert.equal(collections.find((collection) => collection.name === "comments").createdAt, "2026-01-03T00:00:00.000Z");
  const events = await feed(tenant);
  assert.deepEqual(events.map((event) => [event.type, event.collection]), [
    ["collection.created", "posts"], ["collection.created", "comments"], ["collection.updated", "posts"],
  ], "the creation, and the back-reference its target records");
  assert.deepEqual(events.map((event) => event.timestamp), [iso(1000), iso(1000), iso(1000)]);
});

test("a malformed carried collection refuses", async (t) => {
  const tenant = await tenantOf(t);
  for (const carry of [{ createdAt: "yesterday", at: 1 }, { createdAt: iso(0), at: -1 }, { at: 1 }]) {
    await dies(tenant.documents.createCollection({ name: "x", [CARRY_COLLECTION]: carry }), JSON.stringify(carry));
  }
  assert.deepEqual(await run(tenant.documents.listCollections), []);
});

test("history replays one event per change, at its time, with its version", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection(USERS));
  await run(documents.createCollection(POSTS));
  assert.deepEqual(await run(replay(documents, R1_HISTORY)), [],
    "accepted although u1 failed the check and u2 shared u1's email at their time");
  assert.deepEqual(
    (await documentFeed(tenant)).map((event) => [event.type, event.documentId, event.revision, event.timestamp, event.payload.data?.email]),
    [
      ["document.upserted", "u1", 1, iso(1000), "a"],
      ["document.upserted", "u2", 1, iso(1100), "a"],
      ["document.upserted", "u2", 2, iso(1200), "b"],
      ["document.upserted", "u1", 2, iso(1300), "a"],
      ["document.upserted", "u1", 3, iso(1350), "a"],
      ["document.deleted", "u2", 3, iso(1400), undefined],
      ["document.upserted", "u2", 1, iso(1500), "c"],
      ["document.upserted", "p1", 1, iso(1600), undefined],
    ],
  );
  const u1 = await run(documents.findById({ collection: "users", id: "u1" }));
  assert.deepEqual([u1.version, u1.createdAt, u1.updatedAt], [2, iso(1350), iso(1350)], "the last put's carried version and times");
  assert.deepEqual(ids(await run(documents.findMany({ collection: "users", where: [{ path: "email", op: "eq", value: "c" }] }))), ["u2"]);
  assert.deepEqual(await run(documents.findMany({ collection: "users", where: [{ path: "email", op: "eq", value: "b" }] })), [],
    "the index holds only the live value");
  assert.deepEqual(ids(await run(documents.findMany({ collection: "users", linked: { collection: "posts", id: "p1", edge: "wrote" } }))), ["u1"]);
});

test("a replayed retraction does not cascade", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "posts" }));
  await run(documents.createCollection(COMMENTS));
  await run(replay(documents, [put("posts", "p1", {}, 1, 10), put("comments", "c1", { post: "p1" }, 1, 20)]));
  await run(replay(documents, [retract("posts", "p1", 30)]));
  assert.equal(await run(documents.count({ collection: "comments" })), 1, "the comment is a change of its own in the history, or none");
  const events = await documentFeed(tenant);
  assert.deepEqual(events.slice(-2).map((event) => [event.type, event.documentId]),
    [["document.upserted", "c1"], ["document.deleted", "p1"]], "one event for the one retraction");
});

test("a replay failure discards the whole batch", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "users" }));
  assert.equal(tagOf(await failed(replay(documents, [put("users", "u9", {}, 1, 1), retract("users", "missing", 2)]))), "DocumentNotFound");
  assert.equal(await run(documents.count({ collection: "users" })), 0, "the put before the failing retraction is discarded");
  await run(replay(documents, [put("users", "u1", {}, 3, 1)]));
  assert.equal(tagOf(await failed(replay(documents, [put("users", "u1", {}, 2, 2)]))), "DocumentConflict");
  assert.equal(tagOf(await failed(replay(documents, [put("nowhere", "x", {}, 1, 1)]))), "CollectionNotFound");
  assert.equal(tagOf(await failed(replay(documents, [put("users", "u2", { age: Number.POSITIVE_INFINITY }, 1, 1)]))), "InvalidDocumentValue");
  assert.equal(await run(documents.count({ collection: "users" })), 1);
  assert.equal((await run(documents.findById({ collection: "users", id: "u1" }))).version, 3);
});

test("a malformed replay request dies and writes nothing", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "users" }));
  const good = put("users", "u1", {}, 1, 1);
  const request = (changes, extra = {}) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Changes", changes }, ...extra });
  await dies(request([]), "no change");
  await dies(request(Array.from({ length: 1001 }, (_, n) => put("users", `u${n}`, {}, 1, 1))), "1001 changes");
  await dies(request([{ ...good, version: 0 }]), "version 0");
  await dies(request([{ ...good, at: -1 }]), "a negative time");
  await dies(request([{ ...good, createdAt: "yesterday" }]), "a creation time that is no time");
  await dies(request([{ ...good, _tag: "Upsert" }]), "an unknown change");
  await dies(documents.write({ operations: [{ _tag: "Insert", collection: "users", data: {} }], [REPLAY_HISTORY]: { _tag: "Changes", changes: [good] } }), "a replay with operations");
  await dies(request([good], { idempotencyKey: "k" }), "a replay with an idempotency key");
  await dies(request([good], { emit: [{ topic: "t", payload: {} }] }), "a replay with messages");
  assert.equal(await run(documents.count({ collection: "users" })), 0);
  assert.deepEqual(await documentFeed(tenant), []);
});

test("replay events keep the log in time order with a carried collection first", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "notes", [CARRY_COLLECTION]: { createdAt: iso(500), at: 500 } }));
  await run(replay(documents, [put("notes", "n1", {}, 1, 500), put("notes", "n1", {}, 2, 900)]));
  const timestamps = (await feed(tenant)).map((event) => event.timestamp);
  assert.deepEqual(timestamps, [iso(500), iso(500), iso(900)]);
  assert.deepEqual(timestamps, [...timestamps].sort(), "non-decreasing");
});

test("a settled final state passes and writes nothing", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection(USERS));
  await run(documents.createCollection(POSTS));
  await run(replay(documents, R1_HISTORY));
  const before = (await feed(tenant)).length;
  assert.deepEqual(await run(settle(documents, "users", ["u1", "u2"])), []);
  assert.deepEqual(await run(settle(documents, "posts", ["p1"])), []);
  assert.equal((await feed(tenant)).length, before);
});

test("settle refuses what today's rules refuse", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection(USERS));
  await run(documents.createCollection({ name: "posts" }));
  await run(documents.createCollection(COMMENTS));
  await run(replay(documents, [put("users", "a1", { email: "x", age: 20 }, 1, 1), put("users", "a2", { email: "x", age: 20 }, 1, 2)]));
  assert.equal(tagOf(await failed(settle(documents, "users", ["a1", "a2"]))), "UniqueViolation");
  await run(replay(documents, [put("users", "k1", { email: "k", age: 5 }, 1, 3)]));
  assert.equal(tagOf(await failed(settle(documents, "users", ["k1"]))), "CheckViolation");
  await run(replay(documents, [put("comments", "c9", { post: "nope" }, 1, 4)]));
  assert.equal(tagOf(await failed(settle(documents, "comments", ["c9"]))), "ReferenceViolation");
  assert.equal(tagOf(await failed(settle(documents, "users", ["ghost"]))), "DocumentNotFound");
  assert.equal(tagOf(await failed(settle(documents, "nowhere", ["x"]))), "CollectionNotFound");
});

test("a malformed settle dies", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "users" }));
  const request = (collection, wanted) => documents.write({ operations: [], [REPLAY_HISTORY]: { _tag: "Settle", collection, ids: wanted } });
  await dies(request("users", []), "no id");
  await dies(request("users", Array.from({ length: 1001 }, (_, n) => `u${n}`)), "1001 ids");
  await dies(request("users", [1]), "an id that is no string");
  await dies(request(5, ["u1"]), "a collection that is no name");
});

const title = { name: "title", field: { _tag: "TextField", label: "Title", required: false } };
const rank = { name: "rank", field: { _tag: "IntegerField", label: "Rank", required: false } };

test("activating a schema rewrites documents only when it changes a lens declaration", async (t) => {
  const tenant = await tenantOf(t);
  const documents = tenant.documents;
  await run(documents.createCollection({ name: "notes", analyzer: { fields: ["title"], version: 1, fold: true } }));
  for (const [id, text, value] of [["n1", "alpha one", 2], ["n2", "alpha two", 3], ["n3", "bravo", 5]]) {
    await run(documents.insert({ collection: "notes", id, data: { title: text, rank: value } }));
  }
  const before = (await feed(tenant)).length;

  // Version 1 implies an analyzer the collection already declares by hand: no posting changes.
  const first = await run(tenant.schemas.save({ collection: "notes", version: 1, fields: [title] }));
  assert.equal(first.activation.documents, 0);
  const afterFirst = await feed(tenant);
  assert.deepEqual(afterFirst.slice(before).filter((event) => event.documentId !== undefined), [],
    "an activation that changes no lens writes no document event");
  assert.deepEqual(ids(await run(documents.findMany({ collection: "notes", search: "alpha" }))), ["n1", "n2"]);
  assert.deepEqual((await run(tenant.schemas.listVersions("notes"))).map((schema) => [schema.version, schema.active]), [[1, true]]);

  // Version 2 implies a measure nothing declared: every document is written back under it.
  const second = await run(tenant.schemas.save({ collection: "notes", version: 2, fields: [title, rank] }));
  assert.equal(second.activation.documents, 3);
  const afterSecond = (await feed(tenant)).slice(afterFirst.length);
  assert.deepEqual(afterSecond.filter((event) => event.documentId !== undefined).map((event) => [event.type, event.documentId]).sort(),
    [["document.upserted", "n1"], ["document.upserted", "n2"], ["document.upserted", "n3"]]);
  assert.equal((await run(documents.summarize({ collection: "notes", measure: "rank", op: "sum" }))).value, 10,
    "the derived measure is posted for the documents stored before it");
  assert.deepEqual(afterSecond.filter((event) => event.documentId === undefined).map((event) => event.type), ["collection.updated"],
    "the backfill's mark is the store's own: the feed shows the declaration and nothing else");
});
