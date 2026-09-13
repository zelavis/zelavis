// Aggregating without reading the documents.
//
// The measure lens holds one number per document, so an aggregate reads a
// dense vector rather than a million payloads. What these pin is the part that
// is easy to get quietly wrong: a document with no value for the measure is not
// counted, so `avg` divides by the documents that carried one -- and a stored
// zero is a value, while an absent, null, string or non-finite field is not.
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

const MEASURES = [{ name: "price", path: "price" }];

// Four with a price, and four without one for different reasons. The zero is
// the important one: it must count, and it must not be mistaken for absence.
const ROWS = [
  ["a", { price: 10, region: "eu" }],
  ["b", { price: 20, region: "eu" }],
  ["c", { price: 30, region: "us" }],
  ["d", { price: 0, region: "us" }],
  ["e", { region: "eu" }],
  ["f", { price: null, region: "eu" }],
  ["g", { price: "12", region: "us" }],
  ["h", { price: { amount: 5 }, region: "us" }],
];

for (const [engine, open] of engines) {
  const setup = (t, body, { measures = MEASURES, rows = ROWS } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-measure-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({
        name: "items",
        ...(measures === undefined ? {} : { measures }),
      });
      for (const [id, data] of rows) yield* docs.insert({ collection: "items", id, data });
      return yield* body(docs, store);
    })));
  };
  const sum = (docs, input) => docs.summarize({ collection: "items", measure: "price", ...input });
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);

  test(`${engine}: only the documents carrying a value are counted`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // 10 + 20 + 30 + 0 over four documents, not eight.
      assert.deepEqual(yield* sum(docs, { op: "sum" }), { value: 60, documents: 4 });
      assert.deepEqual(yield* sum(docs, { op: "count" }), { value: 4, documents: 4 });
      assert.deepEqual(yield* sum(docs, { op: "avg" }), { value: 15, documents: 4 });
      assert.deepEqual(yield* sum(docs, { op: "min" }), { value: 0, documents: 4 });
      assert.deepEqual(yield* sum(docs, { op: "max" }), { value: 30, documents: 4 });
    })));

  test(`${engine}: a filter narrows before the measure is read`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(
        yield* sum(docs, { op: "sum", where: [{ path: "region", value: "eu" }] }),
        { value: 30, documents: 2 },
      );
      assert.deepEqual(
        yield* sum(docs, { op: "avg", where: [{ path: "region", value: "us" }] }),
        { value: 15, documents: 2 },
      );
      // A filter matching nothing has nothing to average, and says so.
      assert.deepEqual(
        yield* sum(docs, { op: "avg", where: [{ path: "region", value: "mars" }] }),
        { value: 0, documents: 0 },
      );
    })));

  test(`${engine}: spread is over the values present, as a population`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      // 0, 10, 20, 30: mean 15, population variance 125.
      const variance = yield* sum(docs, { op: "variance" });
      assert.equal(variance.value, 125);
      const stddev = yield* sum(docs, { op: "stddev" });
      assert.equal(stddev.value, Math.sqrt(125));
      assert.equal((yield* sum(docs, { op: "countDistinct" })).value, 4);
    })));

  test(`${engine}: grouping reads the group key from the lens, not the document`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const groups = yield* docs.summarizeBy({
        collection: "items", measure: "price", op: "sum", groupBy: "region",
      });
      assert.deepEqual(
        groups.map((g) => [g.key, g.value, g.documents]),
        [["eu", 30, 2], ["us", 30, 2]],
      );
    })));

  test(`${engine}: a measure the collection does not declare says so`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(
        yield* tagOf(sum(docs, { op: "sum", measure: "weight" })),
        "UnknownMeasure",
      );
    })));

  test(`${engine}: a bad measure declaration is refused`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      for (const bad of [
        [{ name: "", path: "price" }],
        [{ name: "price", path: "" }],
        [{ name: "price", path: "price" }, { name: "price", path: "other" }],
      ]) {
        assert.equal(
          yield* tagOf(docs.createCollection({ name: "bad", measures: bad })),
          "InvalidConstraint",
          `${JSON.stringify(bad)} should not be declarable`,
        );
      }
    })));
}
