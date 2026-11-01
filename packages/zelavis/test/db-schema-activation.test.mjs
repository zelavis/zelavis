import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { deriveDeclarations, makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const ACTIVATOR = fileURLToPath(new URL("./fixtures/schema-activator.mjs", import.meta.url));

const open = (dir) => makeDatabase({
  partitionMap: partitionMapFor(["only"]),
  openShard: (shard) => makeNodeSqliteStore(shard, dir),
});

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-activation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    return yield* body(db.forTenant("acme"), db);
  })));
};

const text = (label) => ({ _tag: "TextField", label, required: false });

test("only declarations a schema states safely are derived", () => {
  const derived = deriveDeclarations(3, [
    { name: "title", field: text("Title") },
    { name: "body", field: { _tag: "RichTextField", label: "Body", required: false } },
    { name: "slug", field: { _tag: "SlugField", label: "Slug", required: false } },
    { name: "views", field: { _tag: "IntegerField", label: "Views", required: false } },
    { name: "price", field: { _tag: "NumberField", label: "Price", required: false } },
    { name: "author", field: { _tag: "ReferenceField", label: "Author", required: false, collection: "authors" } },
    { name: "tags", field: { _tag: "ReferenceField", label: "Tags", required: false, collection: "tags", multiple: true } },
    { name: "where", field: { _tag: "GeometryField", label: "Where", required: false, coordinates: "wgs84", resolution: 7 } },
    { name: "shape", field: { _tag: "JsonField", label: "Shape", required: false } },
    { name: "embedding", field: { _tag: "VectorField", label: "E", required: false, model: "m", modelVersion: "2", dimension: 4, metric: "cosine" } },
    { name: "parts", field: { _tag: "RepeaterField", label: "Parts", required: false, fields: [{ name: "n", field: text("N") }] } },
  ]);
  assert.deepEqual(derived.analyzer, { fields: ["title", "body"], version: 3 }, "prose only: a slug is not words");
  assert.deepEqual(derived.measures, [{ name: "views", path: "views" }, { name: "price", path: "price" }]);
  assert.deepEqual(derived.edges, [{ name: "author", path: "author.id", collection: "authors" }]);
  assert.deepEqual(derived.spatial, { fields: ["where"], resolution: 7, version: 3 });
  assert.deepEqual(derived.embedding, { field: "embedding", dimension: 4, metric: "cosine", model: "m", modelVersion: "2", version: 3 });
  // A JSON field holding a shape is not geometry: nothing states its coordinate model.
  assert.deepEqual(derived.skipped.map((entry) => entry.path).sort(), ["parts", "tags"]);

  const two = deriveDeclarations(1, [
    { name: "a", field: { _tag: "VectorField", label: "A", required: false, model: "m", modelVersion: "1", dimension: 2, metric: "dot" } },
    { name: "b", field: { _tag: "VectorField", label: "B", required: false, model: "m", modelVersion: "1", dimension: 2, metric: "dot" } },
    { name: "p", field: { _tag: "GeometryField", label: "P", required: false, coordinates: "wgs84", resolution: 5 } },
    { name: "q", field: { _tag: "GeometryField", label: "Q", required: false, coordinates: "wgs84", resolution: 6 } },
  ]);
  assert.equal(two.embedding, undefined, "two vectors: no single embedding to declare");
  assert.equal(two.spatial, undefined, "two resolutions: no single spatial index");
  assert.equal(two.skipped.length, 4);
});

test("activation declares on the collection, backfills, and replaces only what it derived", async (t) => {
  await withTenant(t, ({ documents, schemas }) => Effect.gen(function* () {
    yield* documents.createCollection({ name: "posts", measures: [{ name: "kept", path: "kept" }] });
    yield* documents.insert({ collection: "posts", id: "a", data: { title: "hello world", views: 3, kept: 1 } });
    const v1 = yield* schemas.save({
      collection: "posts", version: 1,
      fields: [{ name: "title", field: text("Title") }, { name: "views", field: { _tag: "IntegerField", label: "V", required: false } }],
    });
    assert.equal(v1.active, true);
    assert.equal(v1.activation.documents, 1, "the stored document was re-derived");
    const found = yield* documents.findMany({ collection: "posts", search: "hello" });
    assert.deepEqual(found.map((doc) => doc.id), ["a"], "searchable without anyone declaring an analyzer");
    const sum = yield* documents.summarize({ collection: "posts", measure: "views", op: "sum" });
    assert.equal(sum.value, 3);

    // A hand-made analyzer is the caller's: the next activation keeps it.
    yield* documents.analyze({ collection: "posts", analyzer: { fields: ["title"], version: 9, minLength: 1 } });
    const v2 = yield* schemas.save({ collection: "posts", version: 2, fields: [{ name: "title", field: text("Title") }] });
    assert.deepEqual(v2.activation.skipped, [{ path: "title", reason: "the collection declares its analyzer by hand" }]);
    const [posts] = yield* documents.listCollections;
    assert.equal(posts.analyzer.version, 9);
    assert.deepEqual(posts.measures, [{ name: "kept", path: "kept" }], "the derived measure went with v2; the hand-made one stayed");
    assert.equal(posts.derived.schemaVersion, 2);
    assert.deepEqual(yield* schemas.pendingActivations, []);
  }));
});

test("an activation whose declarations stored documents break is refused, leaving everything as it was", async (t) => {
  await withTenant(t, ({ documents, schemas }) => Effect.gen(function* () {
    yield* documents.createCollection({ name: "posts" });
    yield* documents.insert({ collection: "posts", id: "a", data: { title: "hi", e: [1, 2] } });
    yield* schemas.save({ collection: "posts", version: 1, fields: [{ name: "title", field: text("Title") }] });
    const refused = yield* schemas.save({
      collection: "posts", version: 2,
      fields: [{ name: "e", field: { _tag: "VectorField", label: "E", required: false, model: "m", modelVersion: "1", dimension: 3, metric: "cosine" } }],
    }).pipe(Effect.flip);
    assert.equal(refused._tag, "SchemaActivationRefused");
    assert.match(refused.reason, /document "a" e holds 2 numbers, not the 3 declared/);
    assert.equal((yield* schemas.getActive("posts")).version, 1, "v1 still governs writes");
    const [posts] = yield* documents.listCollections;
    assert.deepEqual(posts.analyzer, { fields: ["title"], version: 1 }, "v1's declarations are back");
    assert.equal(posts.embedding, undefined);
    assert.equal(posts.derived.schemaVersion, 1);
    assert.deepEqual(yield* schemas.pendingActivations, [], "a refused activation leaves no intent");
  }));
});

test("a schema activated before its collection exists declares on it when it is created", async (t) => {
  await withTenant(t, ({ documents, schemas }) => Effect.gen(function* () {
    const activated = yield* schemas.save({ collection: "notes", version: 1, fields: [{ name: "body", field: text("Body") }] });
    assert.equal(activated.activation, null, "no collection yet, nothing to backfill");
    const created = yield* documents.createCollection({ name: "notes", surface: "content-studio" });
    assert.deepEqual(created.analyzer, { fields: ["body"], version: 1 });
    yield* documents.insert({ collection: "notes", id: "n", data: { body: "quiet morning" } });
    assert.equal((yield* documents.findMany({ collection: "notes", search: "morning" })).length, 1);
  }));
});

test("an activation killed partway through is finished when the database opens", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-activation-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const markerPath = join(dir, "marker");
  const child = spawn(process.execPath, [ACTIVATOR, dir, markerPath, "4000"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const lines = () => (existsSync(markerPath) ? readFileSync(markerPath, "utf8").split("\n").filter(Boolean) : []);
  // Killed once the intent is committed (the fixture says so), during the backfill of 4000 documents that follows it.
  while (!lines().includes("intent")) await new Promise((resolve) => setTimeout(resolve, 2));
  child.kill("SIGKILL");
  await exited;
  const finished = lines().includes("activated");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    const acme = db.forTenant("acme");
    assert.deepEqual(yield* acme.schemas.pendingActivations, [], "opening resumed it");
    assert.equal((yield* acme.schemas.getActive("posts"))?.version, 1, finished ? "finished before the kill" : "published on open");
    const [posts] = yield* acme.documents.listCollections;
    assert.equal(posts.derived.schemaVersion, 1);
    const hits = yield* acme.documents.summarize({ collection: "posts", measure: "views", op: "count", search: "searchable" });
    assert.equal(hits.value, 4000, "every document was backfilled, before or after the kill");
  })));
});
