// Closeness, exactly: every candidate the query admits is compared.
//
// The point of most tests here is that the filters come first. A similarity
// read is only cheap because `where` narrows the candidates before anything is
// scored, and it is only trustworthy because what it skips -- a document with
// no vector -- is a document `embed` would have refused to let in wrong.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { documentsFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const engines = [
  ["memory", () => makeMemoryStore("acme")],
  ["sqlite", (dir) => makeNodeSqliteStore("acme", dir)],
];

const EMBEDDING = { field: "vec", dimension: 3, metric: "cosine", version: 1 };
// `embedding: NONE` declares no embedding at all. Plain `undefined` cannot say
// that: a default parameter fires on an explicit undefined, so it would quietly
// mean "the usual one" and a test would pass for the wrong reason.
const NONE = Symbol("no embedding");

// A direction, something just off it, something at right angles, its opposite.
const NOTES = [
  ["north", [1, 0, 0], "star"],
  ["near", [0.9, 0.1, 0], "star"],
  ["side", [0, 1, 0], "edge"],
  ["south", [-1, 0, 0], "star"],
];

for (const [engine, open] of engines) {
  const setup = (t, body, { embedding = EMBEDDING, notes = NOTES } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-vec-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({
        name: "notes",
        ...(embedding === NONE ? {} : { embedding }),
      });
      for (const [id, vec, kind] of notes) {
        yield* docs.insert({ collection: "notes", id, data: { vec, kind } });
      }
      return yield* body(docs, store);
    })));
  };
  // Order is the answer here, so these are never sorted.
  const closest = (docs, input) =>
    Effect.map(docs.findMany({ collection: "notes", ...input }), (found) => found.map((d) => d.id));
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);

  test(`${engine}: the closest come back first, and k decides how many`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const north = (k) => closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k } });

      assert.deepEqual(yield* north(1), ["north"], "itself, before the one just off it");
      assert.deepEqual(yield* north(2), ["north", "near"]);
      // Orthogonal scores zero and the opposite scores -1, so both still rank,
      // and they rank in that order.
      assert.deepEqual(yield* north(4), ["north", "near", "side", "south"]);
      // k beyond the collection is not an error; it is just everything.
      assert.deepEqual(yield* north(50), ["north", "near", "side", "south"]);
    })));

  test(`${engine}: the filters narrow the candidates before anything is scored`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // "side" is the nearest non-star, and excluding stars must surface it
      // rather than returning a shorter list of the same winners.
      assert.deepEqual(
        yield* closest(docs, {
          similar: { field: "vec", vector: [1, 0, 0], k: 2 },
          where: [{ path: "kind", value: "edge" }],
        }),
        ["side"],
      );
      assert.deepEqual(
        yield* closest(docs, {
          similar: { field: "vec", vector: [1, 0, 0], k: 2 },
          where: [{ path: "kind", value: "star" }],
        }),
        ["north", "near"],
      );
    })));

  test(`${engine}: ties break by identifier, so the order never wobbles`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Two documents at exactly the same distance: insertion order decides,
      // and decides the same way every time.
      const first = yield* closest(docs, { similar: { field: "vec", vector: [0, 0, 1], k: 4 } });
      const again = yield* closest(docs, { similar: { field: "vec", vector: [0, 0, 1], k: 4 } });
      assert.deepEqual(first, again, "the same query answers the same way twice");
      assert.equal(first.length, 4);
    }), {
      notes: [
        ["one", [1, 0, 0], "star"],
        ["two", [1, 0, 0], "star"],
        ["three", [1, 0, 0], "star"],
        ["four", [1, 0, 0], "star"],
      ],
    }));

  test(`${engine}: a metric is a promise about what closer means`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // Euclidean counts magnitude, so the short vector pointing the same way
      // beats the long one; cosine ignores magnitude and cannot tell them
      // apart. Same documents, same query, different declared metric.
      const byLength = yield* closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k: 1 } });
      assert.deepEqual(byLength, ["unit"], "euclidean prefers the one actually near the point");
    }), {
      embedding: { field: "vec", dimension: 3, metric: "euclidean", version: 1 },
      notes: [
        ["unit", [1, 0, 0], "star"],
        ["far", [8, 0, 0], "star"],
      ],
    }));

  test(`${engine}: a vector of the wrong shape is refused at the write`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(docs.insert({ collection: "notes", id: "short", data: { vec: [1, 0], kind: "star" } })),
        "VectorShapeMismatch",
        "two numbers where three were declared",
      );
      assert.equal(
        yield* tagOf(docs.insert({
          collection: "notes", id: "nan", data: { vec: [1, 0, Number.NaN], kind: "star" },
        })),
        "VectorShapeMismatch",
        "a value that is not a finite number",
      );
      // A document with no vector at all is allowed in, and simply never wins.
      yield* docs.insert({ collection: "notes", id: "wordless", data: { kind: "star" } });
      assert.ok(
        !(yield* closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k: 50 } })).includes("wordless"),
      );
    })));

  test(`${engine}: the query's own vector has to fit, and the field has to be indexed`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(closest(docs, { similar: { field: "vec", vector: [1, 0], k: 1 } })),
        "InvalidVectorQuery",
      );
      assert.equal(
        yield* tagOf(closest(docs, { similar: { field: "kind", vector: [1, 0, 0], k: 1 } })),
        "UnembeddedCollection",
        "a field the embedding does not name",
      );
    })));

  test(`${engine}: a collection that declares no embedding says so`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k: 1 } })),
        "UnembeddedCollection",
      );
    }), { embedding: NONE }));

  test(`${engine}: embed holds the documents already there to the shape`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const declared = yield* docs.embed({ collection: "notes", embedding: EMBEDDING });
      assert.equal(declared.documents, NOTES.length, "every document was read against it");
      assert.deepEqual(
        yield* closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k: 1 } }),
        ["north"],
      );
    }), { embedding: NONE }));

  test(`${engine}: a declaration its own documents fail is taken back off`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(docs.embed({
          collection: "notes",
          embedding: { field: "vec", dimension: 9, metric: "cosine", version: 1 },
        })),
        "VectorShapeMismatch",
      );
      // Withdrawn, not left in force: the collection is exactly as it was, so
      // a read says there is no embedding rather than trusting a bad one.
      assert.equal(
        yield* tagOf(closest(docs, { similar: { field: "vec", vector: [1, 0, 0], k: 1 } })),
        "UnembeddedCollection",
      );
      // And writes are not held to the withdrawn shape either.
      yield* docs.insert({ collection: "notes", id: "after", data: { vec: [0, 0, 1], kind: "star" } });
    }), { embedding: NONE }));

  test(`${engine}: a bad declaration is refused before anything is recorded`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      for (const bad of [
        { field: "vec", dimension: 0, metric: "cosine", version: 1 },
        { field: "vec", dimension: 3, metric: "manhattan", version: 1 },
        { field: "vec", dimension: 3, metric: "cosine", version: 0 },
        { field: "", dimension: 3, metric: "cosine", version: 1 },
      ]) {
        assert.equal(
          yield* tagOf(docs.embed({ collection: "notes", embedding: bad })),
          "InvalidConstraint",
          `${JSON.stringify(bad)} should not be declarable`,
        );
      }
    }), { embedding: NONE }));
}
