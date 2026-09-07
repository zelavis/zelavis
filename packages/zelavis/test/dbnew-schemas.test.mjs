import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/dbnew/index.js";
import { makeNodeSqliteStore } from "../dist/dbnew/adapters/node-sqlite.js";

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db.forTenant("acme"), db);
      }),
    ),
  );
};

const postFields = [
  { name: "title", field: { _tag: "TextField", label: "Title", required: true, maxLength: 10 } },
  { name: "views", field: { _tag: "IntegerField", label: "Views", required: false, min: 0 } },
];

test("schemas: save, version, activate", async (t) => {
  await withTenant(t, ({ schemas }) =>
    Effect.gen(function* () {
      const v1 = yield* schemas.save({ collection: "posts", version: 1, fields: postFields });
      assert.equal(v1.version, 1);
      assert.equal(v1.active, true, "the first version activates by default");

      // A stored version is what earlier documents were validated against.
      const dup = yield* schemas
        .save({ collection: "posts", version: 1, fields: [] })
        .pipe(Effect.as("saved"), Effect.catchTag("SchemaVersionExists", () => Effect.succeed("immutable")));
      assert.equal(dup, "immutable");

      yield* schemas.save({
        collection: "posts",
        version: 2,
        activate: false,
        fields: [...postFields, { name: "slug", field: { _tag: "TextField", label: "Slug", required: false } }],
      });
      assert.equal((yield* schemas.getActive("posts")).version, 1, "activate:false does not switch");

      const versions = yield* schemas.listVersions("posts");
      assert.deepEqual(versions.map((v) => v.version), [1, 2], "sorted");
      assert.deepEqual(versions.map((v) => v.active), [true, false]);

      const activated = yield* schemas.activate("posts", 2);
      assert.equal(activated.active, true);
      assert.equal((yield* schemas.getActive("posts")).version, 2);

      assert.equal(yield* schemas.getVersion("posts", 9), undefined);
      const missing = yield* schemas
        .activate("posts", 9)
        .pipe(Effect.as("activated"), Effect.catchTag("SchemaNotFound", () => Effect.succeed("absent")));
      assert.equal(missing, "absent");

      // Non-contiguous versions are listed correctly, not truncated at a gap.
      yield* schemas.save({ collection: "pages", version: 7, fields: postFields });
      assert.deepEqual((yield* schemas.listVersions("pages")).map((v) => v.version), [7]);

      const summaries = yield* schemas.listCollections();
      assert.deepEqual(summaries.map((s) => s.collection), ["pages", "posts"]);
      assert.deepEqual(summaries.find((s) => s.collection === "posts"), {
        collection: "posts", activeVersion: 2, versions: [1, 2],
      });
    }),
  );
});

test("validation: a collection without a schema accepts anything", async (t) => {
  await withTenant(t, ({ documents, schemas }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "raw" });
      const result = yield* schemas.validate("raw", { anything: [1, 2, 3] });
      assert.deepEqual(result, { schemaVersion: 0, valid: true, issues: [] });

      const doc = yield* documents.insert({ collection: "raw", data: { anything: "goes" } });
      assert.equal(doc.version, 1, "unschematized collections still accept writes");
    }),
  );
});

test("validation: writes are rejected against the active schema", async (t) => {
  await withTenant(t, ({ documents, schemas }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* schemas.save({ collection: "posts", version: 1, fields: postFields });

      const ok = yield* documents.insert({
        collection: "posts", id: "p1", data: { title: "Atlas", views: 3 },
      });
      assert.equal(ok.data.title, "Atlas");

      const rejected = (data) =>
        documents.insert({ collection: "posts", data }).pipe(
          Effect.as(undefined),
          Effect.catchTag("SchemaViolation", (e) => Effect.succeed(e)),
        );

      const missingRequired = yield* rejected({ views: 1 });
      assert.ok(missingRequired, "a missing required field is rejected");
      assert.equal(missingRequired.collection, "posts");
      assert.equal(missingRequired.schemaVersion, 1);
      assert.ok(missingRequired.issues.length > 0, "issues explain what failed");

      assert.ok(yield* rejected({ title: 42 }), "wrong type rejected");
      assert.ok(yield* rejected({ title: "way too long a title" }), "maxLength enforced");
      assert.ok(yield* rejected({ title: "ok", stray: true }), "unknown field rejected");

      // Nothing partial was written by any rejected insert.
      const all = yield* documents.findMany({ collection: "posts" });
      assert.deepEqual(all.map((d) => d.id), ["p1"], "rejected writes left no trace");

      // Updates are validated against the merged result, not just the patch.
      const badUpdate = yield* documents
        .update({ collection: "posts", id: "p1", data: { title: "way too long a title" } })
        .pipe(Effect.as("updated"), Effect.catchTag("SchemaViolation", () => Effect.succeed("rejected")));
      assert.equal(badUpdate, "rejected");
      assert.equal((yield* documents.findById({ collection: "posts", id: "p1" })).data.title, "Atlas");

      const goodUpdate = yield* documents.update({
        collection: "posts", id: "p1", data: { views: 10 },
      });
      assert.equal(goodUpdate.data.views, 10, "a valid merge still passes");
    }),
  );
});

test("validation: activating a new version changes what is accepted", async (t) => {
  await withTenant(t, ({ documents, schemas }) =>
    Effect.gen(function* () {
      yield* documents.createCollection({ name: "posts" });
      yield* schemas.save({ collection: "posts", version: 1, fields: postFields });

      const withSlug = { title: "Atlas", slug: "atlas" };
      const before = yield* documents.insert({ collection: "posts", data: withSlug }).pipe(
        Effect.as("accepted"),
        Effect.catchTag("SchemaViolation", () => Effect.succeed("rejected")),
      );
      assert.equal(before, "rejected", "slug is unknown under version 1");

      yield* schemas.save({
        collection: "posts",
        version: 2,
        fields: [...postFields, { name: "slug", field: { _tag: "TextField", label: "Slug", required: false } }],
      });

      const after = yield* documents.insert({ collection: "posts", data: withSlug });
      assert.equal(after.data.slug, "atlas", "accepted under version 2");
    }),
  );
});

test("schemas are per tenant", async (t) => {
  await withTenant(t, (acme, db) =>
    Effect.gen(function* () {
      const globex = db.forTenant("globex");
      yield* acme.documents.createCollection({ name: "posts" });
      yield* globex.documents.createCollection({ name: "posts" });
      yield* acme.schemas.save({ collection: "posts", version: 1, fields: postFields });

      assert.equal(yield* globex.schemas.getActive("posts"), undefined, "not visible to another tenant");
      assert.deepEqual(yield* globex.schemas.listCollections(), []);

      // Constrained for one tenant, unconstrained for the other.
      const strict = yield* acme.documents.insert({ collection: "posts", data: { stray: 1 } }).pipe(
        Effect.as("accepted"), Effect.catchTag("SchemaViolation", () => Effect.succeed("rejected")));
      assert.equal(strict, "rejected");
      const loose = yield* globex.documents.insert({ collection: "posts", data: { stray: 1 } });
      assert.equal(loose.data.stray, 1);
    }),
  );
});
