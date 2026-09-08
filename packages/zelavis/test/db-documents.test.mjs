import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withDocs = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-docs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeNodeSqliteStore("acme", dir);
        const docs = documentsFor(store, "t1");
        return yield* body(docs, store);
      }),
    ),
  );
};

const tagOf = (effect) =>
  effect.pipe(Effect.as("ok"), Effect.catchCause((c) => Effect.succeed(String(c))));

test("collections: create, list, reject reserved and malformed names", async (t) => {
  await withDocs(t, (docs) =>
    Effect.gen(function* () {
      const posts = yield* docs.createCollection({ name: "posts" });
      assert.equal(posts.name, "posts");
      assert.equal(posts.surface, "database", "surface defaults to database");

      yield* docs.createCollection({ name: "pages", surface: "content-studio" });
      const all = yield* docs.listCollections();
      assert.deepEqual(all.map((c) => c.name), ["pages", "posts"], "sorted by name");

      assert.equal(yield* docs.collectionExists("posts"), true);
      assert.equal(yield* docs.collectionExists("absent"), false);

      const dup = yield* docs.createCollection({ name: "posts" }).pipe(
        Effect.as("created"),
        Effect.catchTag("CollectionExists", () => Effect.succeed("exists")),
      );
      assert.equal(dup, "exists");

      for (const bad of ["zv_events", "zv.internal", "9lives", "has space"]) {
        const outcome = yield* docs.createCollection({ name: bad }).pipe(
          Effect.as("created"),
          Effect.catchTag("InvalidCollectionName", () => Effect.succeed("rejected")),
        );
        assert.equal(outcome, "rejected", `"${bad}" must be rejected`);
      }
    }),
  );
});

test("documents: insert, findById, update merge/replace, delete", async (t) => {
  await withDocs(t, (docs) =>
    Effect.gen(function* () {
      yield* docs.createCollection({ name: "posts" });

      const created = yield* docs.insert({
        collection: "posts",
        id: "p1",
        data: { title: "Atlas", views: 10, draft: true },
      });
      assert.equal(created.version, 1);
      assert.equal(created.createdAt, created.updatedAt);

      const found = yield* docs.findById({ collection: "posts", id: "p1" });
      assert.deepEqual(found.data, { title: "Atlas", views: 10, draft: true });

      const merged = yield* docs.update({
        collection: "posts",
        id: "p1",
        data: { views: 11 },
      });
      assert.equal(merged.version, 2);
      assert.deepEqual(merged.data, { title: "Atlas", views: 11, draft: true }, "merge keeps fields");

      const replaced = yield* docs.update({
        collection: "posts",
        id: "p1",
        data: { title: "Beacon" },
        mode: "replace",
      });
      assert.deepEqual(replaced.data, { title: "Beacon" }, "replace drops fields");

      assert.equal(yield* docs.delete({ collection: "posts", id: "p1" }), true);
      assert.equal(yield* docs.findById({ collection: "posts", id: "p1" }), undefined);
      assert.equal(yield* docs.delete({ collection: "posts", id: "p1" }), false, "delete is idempotent");
    }),
  );
});

test("documents: identity, missing collections and optimistic concurrency", async (t) => {
  await withDocs(t, (docs) =>
    Effect.gen(function* () {
      const orphan = yield* docs.insert({ collection: "nope", data: {} }).pipe(
        Effect.as("inserted"),
        Effect.catchTag("CollectionNotFound", () => Effect.succeed("no-collection")),
      );
      assert.equal(orphan, "no-collection");

      yield* docs.createCollection({ name: "posts" });
      yield* docs.insert({ collection: "posts", id: "p1", data: { n: 1 } });

      const dup = yield* docs.insert({ collection: "posts", id: "p1", data: { n: 2 } }).pipe(
        Effect.as("inserted"),
        Effect.catchTag("DocumentConflict", () => Effect.succeed("duplicate")),
      );
      assert.equal(dup, "duplicate", "ids are unique within a collection");

      const stale = yield* docs
        .update({ collection: "posts", id: "p1", data: { n: 3 }, expectedVersion: 99 })
        .pipe(Effect.as("updated"), Effect.catchTag("DocumentConflict", () => Effect.succeed("conflict")));
      assert.equal(stale, "conflict");

      const ok = yield* docs.update({
        collection: "posts", id: "p1", data: { n: 3 }, expectedVersion: 1,
      });
      assert.equal(ok.version, 2, "matching version succeeds");

      const gone = yield* docs
        .update({ collection: "posts", id: "absent", data: {} })
        .pipe(Effect.as("updated"), Effect.catchTag("DocumentNotFound", () => Effect.succeed("missing")));
      assert.equal(gone, "missing");

      // The same id in a different collection is a different document.
      yield* docs.createCollection({ name: "pages" });
      yield* docs.insert({ collection: "pages", id: "p1", data: { n: 100 } });
      const page = yield* docs.findById({ collection: "pages", id: "p1" });
      assert.equal(page.data.n, 100);
      const post = yield* docs.findById({ collection: "posts", id: "p1" });
      assert.equal(post.data.n, 3);
    }),
  );
});

test("findMany: eq and in are index-served, comparisons are applied after", async (t) => {
  await withDocs(t, (docs) =>
    Effect.gen(function* () {
      yield* docs.createCollection({ name: "sites" });
      const rows = [
        { id: "a", region: "eu-west", plan: "pro", visits: 10, nested: { tier: 1 } },
        { id: "b", region: "eu-west", plan: "free", visits: 50, nested: { tier: 2 } },
        { id: "c", region: "us-east", plan: "pro", visits: 30, nested: { tier: 1 } },
        { id: "d", region: "eu-west", plan: "pro", visits: 70, nested: { tier: 3 } },
      ];
      for (const { id, ...data } of rows) {
        yield* docs.insert({ collection: "sites", id, data });
      }

      const ids = (found) => found.map((d) => d.id).sort();

      assert.deepEqual(ids(yield* docs.findMany({ collection: "sites" })), ["a", "b", "c", "d"]);

      assert.deepEqual(
        ids(yield* docs.findMany({ collection: "sites", where: [{ path: "region", value: "eu-west" }] })),
        ["a", "b", "d"], "eq");

      assert.deepEqual(
        ids(yield* docs.findMany({
          collection: "sites",
          where: [{ path: "region", value: "eu-west" }, { path: "plan", value: "pro" }],
        })), ["a", "d"], "two eq filters intersect");

      assert.deepEqual(
        ids(yield* docs.findMany({
          collection: "sites",
          where: [{ path: "plan", op: "in", value: ["pro", "free"] }, { path: "region", value: "eu-west" }],
        })), ["a", "b", "d"], "in");

      assert.deepEqual(
        ids(yield* docs.findMany({ collection: "sites", where: [{ path: "visits", op: "gt", value: 25 }] })),
        ["b", "c", "d"], "gt applied after the lens");

      assert.deepEqual(
        ids(yield* docs.findMany({ collection: "sites", where: [{ path: "nested.tier", value: 1 }] })),
        ["a", "c"], "dotted paths are indexed");

      const sorted = yield* docs.findMany({
        collection: "sites", orderBy: [{ path: "visits", direction: "desc" }],
      });
      assert.deepEqual(sorted.map((d) => d.id), ["d", "b", "c", "a"], "orderBy desc");

      const page = yield* docs.findMany({
        collection: "sites", orderBy: [{ path: "visits" }], limit: 2, offset: 1,
      });
      assert.deepEqual(page.map((d) => d.id), ["c", "b"], "limit and offset");

      // A collection's documents never leak into another's results.
      yield* docs.createCollection({ name: "other" });
      yield* docs.insert({ collection: "other", id: "x", data: { region: "eu-west" } });
      assert.deepEqual(
        ids(yield* docs.findMany({ collection: "sites", where: [{ path: "region", value: "eu-west" }] })),
        ["a", "b", "d"], "collection scoping holds");
    }),
  );
});

test("documents survive a lens rebuild from the event log", async (t) => {
  await withDocs(t, (docs, store) =>
    Effect.gen(function* () {
      yield* docs.createCollection({ name: "posts" });
      yield* docs.insert({ collection: "posts", id: "p1", data: { tag: "atlas" } });
      yield* docs.insert({ collection: "posts", id: "p2", data: { tag: "beacon" } });
      yield* docs.update({ collection: "posts", id: "p2", data: { tag: "cobalt" } });

      yield* store.rebuildLenses;

      const found = yield* docs.findMany({ collection: "posts", where: [{ path: "tag", value: "cobalt" }] });
      assert.deepEqual(found.map((d) => d.id), ["p2"], "postings rebuilt");
      const byId = yield* docs.findById({ collection: "posts", id: "p1" });
      assert.equal(byId.data.tag, "atlas", "identity rebuilt");
      assert.equal((yield* docs.listCollections()).length, 1, "collections rebuilt");
    }),
  );
});
