// A batch: several changes as one, or none of them.
//
// Every check a single write makes is made against what the batch has written
// so far as well as what is committed, which is what lets changes in one batch
// depend on each other — and what stops two of them taking one unique value.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

for (const [engine, open] of engines) {
  const setup = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-batches-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const docs = documentsFor(yield* open(dir), "t1");
      yield* docs.createCollection({ name: "authors" });
      yield* docs.createCollection({
        name: "posts",
        indexes: [{ name: "by_slug", fields: [{ path: "slug" }], unique: true }],
        checks: [{ name: "rated", where: [{ path: "stars", op: "lte", value: 5 }] }],
        references: [{ name: "author", path: "authorId", collection: "authors" }],
      });
      return yield* body(docs);
    })));
  };
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
  const at = (docs, collection, id) => docs.findById({ collection, id });
  const insert = (collection, id, data) => ({ _tag: "Insert", collection, id, data });

  test(`${engine}: changes in one batch see each other`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // The post names an author that does not exist until this batch lands.
      const written = yield* docs.write({
        operations: [
          insert("authors", "a1", { name: "Ann" }),
          insert("posts", "p1", { authorId: "a1", slug: "one", stars: 3 }),
        ],
      });
      assert.deepEqual(written.map((entry) => entry._tag), ["Inserted", "Inserted"]);
      assert.equal(written[1].document.data.authorId, "a1");

      // The author is deleted after the post naming it, which a reference that
      // restricts allows only in this order.
      const cleared = yield* docs.write({
        operations: [
          { _tag: "Delete", collection: "posts", id: "p1" },
          { _tag: "Delete", collection: "authors", id: "a1" },
        ],
      });
      assert.deepEqual(cleared.map((entry) => entry.deleted), [true, true]);
      assert.equal(yield* at(docs, "authors", "a1"), undefined);

      // A document deleted in a batch is gone for the changes after it.
      yield* docs.write({ operations: [insert("authors", "a2", {}), insert("posts", "p2", { authorId: "a2" })] });
      const again = yield* docs.write({
        operations: [
          { _tag: "Delete", collection: "posts", id: "p2" },
          insert("posts", "p2", { authorId: "a2", slug: "two" }),
        ],
      });
      const reinserted = yield* at(docs, "posts", "p2");
      assert.deepEqual([again[1]._tag, reinserted.version, reinserted.data.slug], ["Inserted", 1, "two"]);
    })));

  test(`${engine}: a batch lands whole or not at all`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const refused = yield* Effect.flip(docs.write({
        operations: [
          insert("authors", "a1", { name: "Ann" }),
          insert("posts", "p1", { authorId: "a1", stars: 9 }),
        ],
      }));
      assert.equal(refused._tag, "CheckViolation");
      assert.equal(yield* at(docs, "authors", "a1"), undefined, "the author went back with the post");

      // Two changes cannot take one unique value, which no single write would catch.
      yield* docs.write({ operations: [insert("authors", "a2", {})] });
      assert.equal(yield* tagOf(docs.write({
        operations: [insert("posts", "p2", { slug: "s" }), insert("posts", "p3", { slug: "s" })],
      })), "UniqueViolation");
      assert.equal(yield* at(docs, "posts", "p2"), undefined);

      // A reference to a document no batch creates is refused as ever.
      assert.equal(yield* tagOf(docs.write({ operations: [insert("posts", "p4", { authorId: "ghost" })] })),
        "ReferenceViolation");
    })));

  test(`${engine}: a version and a precondition hold inside a batch`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.write({ operations: [insert("authors", "a1", { name: "Ann", status: "draft" })] });
      const updated = yield* docs.write({
        operations: [{
          _tag: "Update", collection: "authors", id: "a1",
          data: { status: "live" }, expectedVersion: 1,
          precondition: [{ path: "status", value: "draft" }],
        }],
      });
      assert.deepEqual([updated[0]._tag, updated[0].document.version], ["Updated", 2]);

      const stale = yield* Effect.flip(docs.write({
        operations: [
          { _tag: "Update", collection: "authors", id: "a1", data: { name: "Anne" } },
          { _tag: "Update", collection: "authors", id: "a1", data: { name: "Annie" }, expectedVersion: 1 },
        ],
      }));
      assert.equal(stale._tag, "DocumentConflict");
      assert.equal((yield* at(docs, "authors", "a1")).data.name, "Ann", "the first update went back too");

      // Two updates of one document in a batch build on each other.
      const twice = yield* docs.write({
        operations: [
          { _tag: "Update", collection: "authors", id: "a1", data: { name: "Anne" } },
          { _tag: "Update", collection: "authors", id: "a1", data: { title: "editor" } },
        ],
      });
      assert.deepEqual(
        [twice[1].document.data.name, twice[1].document.data.title, twice[1].document.version],
        ["Anne", "editor", 4],
      );
      assert.equal(yield* tagOf(docs.write({
        operations: [{ _tag: "Update", collection: "authors", id: "gone", data: {} }],
      })), "DocumentNotFound");
      assert.deepEqual(
        (yield* docs.write({ operations: [{ _tag: "Delete", collection: "authors", id: "gone" }] }))[0].deleted,
        false,
      );
    })));

  test(`${engine}: a keyed batch is applied once, and an empty one is refused`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const operations = [insert("authors", "a1", { name: "Ann" }), insert("posts", "p1", { authorId: "a1" })];
      const first = yield* docs.write({ operations, idempotencyKey: "k1" });
      const replay = yield* docs.write({ operations, idempotencyKey: "k1" });
      assert.deepEqual(replay, first, "the replay is answered with what the first attempt did");
      assert.equal((yield* docs.findMany({ collection: "posts" })).length, 1);

      const empty = yield* Effect.exit(docs.write({ operations: [] }));
      assert.ok(Exit.isFailure(empty), "a batch of nothing is a mistake, not a no-op");
    })));

  test(`${engine}: sparse attributes are what a wide column is here`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // One collection, documents with nothing in common but their collection:
      // every scalar a document happens to hold is indexed under its own path.
      yield* docs.createCollection({ name: "things" });
      yield* docs.write({
        operations: [
          insert("things", "t1", { weight: 3, spec: { colour: "red" } }),
          insert("things", "t2", { title: "second", tags: { hot: true } }),
          insert("things", "t3", { weight: 9, title: "third" }),
        ],
      });
      const matching = (where) => Effect.map(docs.findMany({ collection: "things", where }), (found) => found.map((d) => d.id));
      assert.deepEqual(yield* matching([{ path: "spec.colour", value: "red" }]), ["t1"]);
      assert.deepEqual(yield* matching([{ path: "tags.hot", value: true }]), ["t2"]);
      assert.deepEqual(yield* matching([{ path: "weight", op: "gte", value: 3 }]), ["t1", "t3"]);
      // A field no document had yet needs no migration to become queryable.
      yield* docs.write({ operations: [{ _tag: "Update", collection: "things", id: "t2", data: { weight: 1 } }] });
      assert.deepEqual(yield* matching([{ path: "weight", op: "lte", value: 3 }]), ["t1", "t2"]);
      // Documents lacking the field sort after those that have it, in either direction.
      const ordered = yield* docs.findMany({ collection: "things", orderBy: [{ path: "title" }] });
      assert.deepEqual(ordered.map((d) => d.id), ["t2", "t3", "t1"]);
    })));
}
