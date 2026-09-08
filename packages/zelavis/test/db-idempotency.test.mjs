import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-idem-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0", "s1"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      const docs = db.forTenant("acme").documents;
      yield* docs.createCollection({ name: "posts" });
      return yield* body(docs, db);
    })),
  );
};

test("a retried insert is answered, not repeated", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      const input = {
        collection: "posts",
        id: "p1",
        data: { title: "Atlas" },
        idempotencyKey: "req-1",
      };

      const first = yield* docs.insert(input);
      const again = yield* docs.insert(input);

      assert.deepEqual(again, first, "the retry returns what the first attempt returned");
      assert.equal(again.version, 1, "and not a second write at a higher version");

      // Without the key this is the conflict a retry would otherwise hit, which
      // is the thing the caller is trying not to have to distinguish from a
      // genuine duplicate.
      const unkeyed = yield* Effect.flip(
        docs.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } }));
      assert.equal(unkeyed._tag, "DocumentConflict");

      const all = yield* docs.findMany({ collection: "posts" });
      assert.equal(all.length, 1, "one document, however many times it was asked for");
    }),
  );
});

test("a retried update does not bump the version again", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      yield* docs.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });

      const input = {
        collection: "posts",
        id: "p1",
        data: { title: "Beacon" },
        idempotencyKey: "req-2",
      };
      const first = yield* docs.update(input);
      const again = yield* docs.update(input);

      assert.equal(first.version, 2);
      assert.deepEqual(again, first);

      const stored = yield* docs.findById({ collection: "posts", id: "p1" });
      assert.equal(stored.version, 2, "the document was written once");
      assert.equal(stored.data.title, "Beacon");
    }),
  );
});

test("a retried delete replays its answer", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      yield* docs.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });

      const input = { collection: "posts", id: "p1", idempotencyKey: "req-3" };
      assert.equal(yield* docs.delete(input), true);
      assert.equal(yield* docs.delete(input), true, "the retry is told what happened");

      // A delete that found nothing records nothing, so a later attempt on a
      // document that has come back does the work rather than replaying a "no"
      // from when it was already gone.
      const missing = { collection: "posts", id: "p2", idempotencyKey: "req-4" };
      assert.equal(yield* docs.delete(missing), false);
      yield* docs.insert({ collection: "posts", id: "p2", data: { title: "Beacon" } });
      assert.equal(yield* docs.delete(missing), true);
    }),
  );
});

test("a key offered for a different request is refused", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      yield* docs.insert({
        collection: "posts", id: "p1", data: { title: "Atlas" }, idempotencyKey: "req-5",
      });

      // Replying with the stored outcome would tell the caller their new
      // document was written when the old one had been.
      const reused = yield* Effect.flip(docs.insert({
        collection: "posts", id: "p2", data: { title: "Beacon" }, idempotencyKey: "req-5",
      }));
      assert.equal(reused._tag, "IdempotencyKeyReused");
      assert.equal(reused.key, "req-5");
      assert.equal(reused.tenant, "acme");
      assert.match(reused.detail, /first used for insert/);

      // The rejected write did not happen.
      assert.equal(yield* docs.findById({ collection: "posts", id: "p2" }), undefined);

      // Nor across operations: the same key on a different verb is a different
      // request even against the same document.
      const crossed = yield* Effect.flip(
        docs.delete({ collection: "posts", id: "p1", idempotencyKey: "req-5" }));
      assert.equal(crossed._tag, "IdempotencyKeyReused");
    }),
  );
});

test("the same request is the same request whatever order its fields arrive in", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      const first = yield* docs.insert({
        collection: "posts",
        id: "p1",
        data: { title: "Atlas", body: "one", tags: ["a", "b"] },
        idempotencyKey: "req-6",
      });

      // A retry serialized from a different client, or through a different JSON
      // library, arrives with its keys in another order. It is the same
      // request, and a fingerprint that disagreed would refuse a legitimate
      // retry — the failure mode a caller would find hardest to explain.
      const again = yield* docs.insert({
        idempotencyKey: "req-6",
        data: { tags: ["a", "b"], body: "one", title: "Atlas" },
        id: "p1",
        collection: "posts",
      });
      assert.deepEqual(again, first);

      // Order within an array is not incidental, though, and changing it is a
      // different request.
      const reordered = yield* Effect.flip(docs.insert({
        collection: "posts",
        id: "p1",
        data: { title: "Atlas", body: "one", tags: ["b", "a"] },
        idempotencyKey: "req-6",
      }));
      assert.equal(reordered._tag, "IdempotencyKeyReused");
    }),
  );
});

test("a key belongs to one tenant", async (t) => {
  await withTenant(t, (docs, db) =>
    Effect.gen(function* () {
      yield* docs.insert({
        collection: "posts", id: "p1", data: { title: "Atlas" }, idempotencyKey: "shared",
      });

      // Callers pick these strings themselves, so two tenants choosing the same
      // one is ordinary rather than an error.
      const other = db.forTenant("bravo").documents;
      yield* other.createCollection({ name: "posts" });
      const theirs = yield* other.insert({
        collection: "posts", id: "p1", data: { title: "Beacon" }, idempotencyKey: "shared",
      });
      assert.equal(theirs.data.title, "Beacon");

      const ours = yield* docs.findById({ collection: "posts", id: "p1" });
      assert.equal(ours.data.title, "Atlas", "neither tenant answered the other's request");
    }),
  );
});

test("a write that failed spends no key", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      // The document exists, so this insert conflicts and nothing is written.
      yield* docs.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
      const conflict = yield* Effect.flip(docs.insert({
        collection: "posts", id: "p1", data: { title: "Beacon" }, idempotencyKey: "req-9",
      }));
      assert.equal(conflict._tag, "DocumentConflict");

      // The key must still be spendable. A receipt written for an attempt that
      // did nothing would lock the caller out of ever completing the request:
      // every retry would be answered with the failure, and a corrected one
      // would be refused as a different request.
      const corrected = yield* docs.insert({
        collection: "posts", id: "p2", data: { title: "Beacon" }, idempotencyKey: "req-9",
      });
      assert.equal(corrected.id, "p2");

      // Same for a write refused by a schema, which is the other way a keyed
      // attempt gets no further than validation.
      const missing = yield* Effect.flip(docs.update({
        collection: "posts", id: "gone", data: { title: "x" }, idempotencyKey: "req-10",
      }));
      assert.equal(missing._tag, "DocumentNotFound");
      yield* docs.insert({ collection: "posts", id: "gone", data: { title: "here" } });
      const retried = yield* docs.update({
        collection: "posts", id: "gone", data: { title: "x" }, idempotencyKey: "req-10",
      });
      assert.equal(retried.data.title, "x");
    }),
  );
});

test("keyed writes survive a relocation with the tenant", async (t) => {
  await withTenant(t, (docs, db) =>
    Effect.gen(function* () {
      yield* docs.insert({
        collection: "posts", id: "p1", data: { title: "Atlas" }, idempotencyKey: "req-8",
      });

      yield* db.movement.rebalance({
        version: 2,
        virtualRanges: 256,
        placements: [{ from: 0, to: 256, shard: db.shardOf("acme") === "s0" ? "s1" : "s0" }],
      });

      // A receipt that stayed behind would turn a retry arriving after a
      // rebalance into a duplicate write — the one moment a client is most
      // likely to be retrying.
      const moved = db.forTenant("acme").documents;
      const again = yield* moved.insert({
        collection: "posts", id: "p1", data: { title: "Atlas" }, idempotencyKey: "req-8",
      });
      assert.equal(again.version, 1, "the retry was answered on the new shard");
      assert.equal((yield* moved.findMany({ collection: "posts" })).length, 1);
    }),
  );
});

test("receipts can be forgotten, and forgetting one lets the work happen again", async (t) => {
  await withTenant(t, (docs) =>
    Effect.gen(function* () {
      for (let i = 1; i <= 4; i++) {
        yield* docs.insert({
          collection: "posts", id: `p${i}`, data: { title: `t${i}` }, idempotencyKey: `k${i}`,
        });
      }
      const cutoff = new Date(Date.now() + 1000).toISOString();
      yield* docs.insert({
        collection: "posts", id: "p5", data: { title: "t5" }, idempotencyKey: "k5",
      });

      // Nothing expires on its own: how long a retry may arrive is the caller's
      // question, so the sweep is theirs to run.
      assert.equal(yield* docs.forgetIdempotencyKeys({ before: "1970-01-01T00:00:00.000Z" }), 0);

      const dropped = yield* docs.forgetIdempotencyKeys({ before: cutoff });
      assert.equal(dropped, 5, "receipts written before the cutoff went");

      // A forgotten key is an ordinary write again. For an insert that is a
      // duplicate-id conflict rather than a duplicate document — pruning too
      // early costs a refusal, not a repeat.
      const after = yield* Effect.flip(docs.insert({
        collection: "posts", id: "p1", data: { title: "t1" }, idempotencyKey: "k1",
      }));
      assert.equal(after._tag, "DocumentConflict");
      assert.equal((yield* docs.findMany({ collection: "posts" })).length, 5);

      // And the key is free for something else, since nothing remembers it.
      const reissued = yield* docs.insert({
        collection: "posts", id: "p6", data: { title: "t6" }, idempotencyKey: "k1",
      });
      assert.equal(reissued.id, "p6");

      assert.equal(yield* docs.forgetIdempotencyKeys(), 1, "and a sweep with no cutoff takes all");
      assert.equal(yield* docs.forgetIdempotencyKeys(), 0);
    }),
  );
});
