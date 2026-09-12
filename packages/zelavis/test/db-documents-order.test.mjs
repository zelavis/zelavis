// Documents in order: comparisons, orderBy and pages, served by the ordered lens.
//
// These pin the semantics a caller relies on and cannot see: values compare
// like with like and never by the host's locale, a document without the field
// has one defined place, and a page walk returns every match exactly once.
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

// Every kind a field can hold, plus a field that is absent and one that is an object.
const ROWS = [
  ["p1", { price: 5 }],
  ["p2", { price: 12 }],
  ["p3", { price: "10" }],
  ["p4", { price: null }],
  ["p5", { name: "no price" }],
  ["p6", { price: true }],
  ["p7", { price: 12.5 }],
  ["p8", { price: { amount: 3 } }],
  ["t1", { price: 7 }],
  ["t2", { price: 7 }],
];
// Booleans, numbers (ties in insertion order), strings; then, in either
// direction, documents whose price is null or absent or an object, in
// insertion order.
const ASCENDING = ["p6", "p1", "t1", "t2", "p2", "p7", "p3", "p4", "p5", "p8"];
const DESCENDING = ["p3", "p7", "p2", "t2", "t1", "p1", "p6", "p4", "p5", "p8"];

for (const [engine, open] of engines) {
  const withDocs = (t, body) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-docorder-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const docs = documentsFor(yield* open(dir), "t1");
      yield* docs.createCollection({ name: "items" });
      for (const [id, data] of ROWS) yield* docs.insert({ collection: "items", id, data });
      return yield* body(docs);
    })));
  };
  const ids = (found) => found.map((d) => d.id);
  const find = (docs, input) => Effect.map(docs.findMany({ collection: "items", ...input }), ids);
  const walk = (docs, input) => Effect.gen(function* () {
    const pages = [];
    let after;
    for (let i = 0; i < 1000; i++) {
      const page = yield* docs.findPage({ collection: "items", ...input, ...(after === undefined ? {} : { after }) });
      pages.push(ids(page.documents));
      if (page.next === undefined) return pages;
      after = page.next;
    }
    throw new Error("findPage never ended");
  });

  test(`${engine}: comparisons are served by the ordered lens and compare like with like`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      const where = (op, value) => find(docs, { where: [{ path: "price", op, value }] });
      assert.deepEqual((yield* where("gt", 10)).sort(), ["p2", "p7"], "not \"10\", null, true, absent or an object");
      assert.deepEqual((yield* where("lt", 7)).sort(), ["p1"]);
      assert.deepEqual((yield* where("gte", 7)).sort(), ["p2", "p7", "t1", "t2"]);
      assert.deepEqual((yield* where("gte", "1")).sort(), ["p3"], "strings compare with strings");
      assert.deepEqual((yield* where("lte", false)).sort(), [], "only false is at or below false");
      assert.deepEqual((yield* where("gte", false)).sort(), ["p6"]);
    })));

  test(`${engine}: eq and in are typed, so 10 does not match "10"`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* find(docs, { where: [{ path: "price", value: 12 }] }), ["p2"]);
      assert.deepEqual(yield* find(docs, { where: [{ path: "price", value: "10" }] }), ["p3"]);
      assert.deepEqual(yield* find(docs, { where: [{ path: "price", value: 10 }] }), []);
      assert.deepEqual((yield* find(docs, { where: [{ path: "price", op: "in", value: [5, "10"] }] })).sort(), ["p1", "p3"]);
      assert.deepEqual(yield* find(docs, { where: [{ path: "price", value: "true" }] }), []);
    })));

  test(`${engine}: one field orders from the lens, null and absent last in either direction`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price" }] }), ASCENDING);
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price", direction: "desc" }] }), DESCENDING);
      // Two fields sort in memory in the lens's order, null and absent last.
      // The one difference: documents equal on every field keep ascending
      // insertion order, where a descending read of the lens reverses them.
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price", direction: "desc" }, { path: "unused" }] }),
        ["p3", "p7", "p2", "t1", "t2", "p1", "p6", "p4", "p5", "p8"]);
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price" }], limit: 3, offset: 2 }), ASCENDING.slice(2, 5));
    })));

  test(`${engine}: findPage returns every match once, and the last page is never empty`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      for (const limit of [1, 2, 3, 100]) {
        for (const direction of ["asc", "desc"]) {
          const pages = yield* walk(docs, { orderBy: [{ path: "price", direction }], limit });
          const expected = direction === "asc" ? ASCENDING : DESCENDING;
          assert.deepEqual(pages.flat(), expected, `${direction}, ${limit} per page`);
          assert.ok(pages.every((page) => page.length > 0), `an empty page at ${limit} per page`);
        }
      }
      // A filter checked against each document keeps the walk exact.
      const where = [{ path: "price", op: "ne", value: 12 }];
      assert.deepEqual((yield* walk(docs, { where, orderBy: [{ path: "price" }], limit: 2 })).flat(),
        yield* find(docs, { where, orderBy: [{ path: "price" }] }));
      // Without an order, documents come in identifier order.
      assert.deepEqual((yield* walk(docs, { limit: 3 })).flat(), ROWS.map(([id]) => id));
      assert.deepEqual(yield* walk(docs, { where: [{ path: "price", value: 999 }] }), [[]]);
    })));

  test(`${engine}: a page can hand back the cursor after each of its documents`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      const orderBy = [{ path: "price" }];
      const page = yield* docs.findPage({ collection: "items", orderBy, limit: 4, cursors: true });
      assert.equal(page.cursors.length, 4);
      assert.equal(page.cursors[3], page.next, "the last one is the page's own next");
      const resumed = yield* docs.findPage({ collection: "items", orderBy, limit: 3, after: page.cursors[1] });
      assert.deepEqual(ids(resumed.documents), ASCENDING.slice(2, 5));
      assert.equal((yield* docs.findPage({ collection: "items", limit: 2 })).cursors, undefined);
    })));

  test(`${engine}: a page cursor continues only its own read`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "other" });
      const { next } = yield* docs.findPage({ collection: "items", orderBy: [{ path: "price" }], limit: 2 });
      const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: [{ path: "price", direction: "desc" }], after: next })), "CursorMismatch");
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: [{ path: "name" }], after: next })), "CursorMismatch");
      assert.equal(yield* tagOf(docs.findPage({ collection: "other", orderBy: [{ path: "price" }], after: next })), "CursorMismatch");
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", after: next })), "CursorMismatch");
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", after: "garbage" })), "CursorMismatch");
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: [{ path: "price" }, { path: "name" }] })), "UnsupportedOrdering");
    })));

  test(`${engine}: several fields sort in memory in the lens's order, never the host's`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      yield* docs.createCollection({ name: "people" });
      for (const [id, name] of [["a", "alpha"], ["b", "Beta"], ["z", "Zed"]]) {
        yield* docs.insert({ collection: "people", id, data: { group: 1, name } });
      }
      const sorted = yield* docs.findMany({ collection: "people", orderBy: [{ path: "group" }, { path: "name" }] });
      // Code point order: uppercase before lowercase. A locale would put alpha first.
      assert.deepEqual(ids(sorted), ["b", "z", "a"]);
    })));

  test(`${engine}: an update moves a document through the order, and a delete removes it`, (t) =>
    withDocs(t, (docs) => Effect.gen(function* () {
      yield* docs.update({ collection: "items", id: "p1", data: { price: 100 } });
      yield* docs.delete({ collection: "items", id: "p2" });
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price" }] }),
        ["p6", "t1", "t2", "p7", "p1", "p3", "p4", "p5", "p8"]);
      assert.deepEqual(yield* find(docs, { orderBy: [{ path: "price", direction: "desc" }] }),
        ["p3", "p1", "p7", "t2", "t1", "p6", "p4", "p5", "p8"]);
      assert.deepEqual((yield* find(docs, { where: [{ path: "price", op: "gt", value: 50 }] })), ["p1"]);
    })));
}
