// Composite indexes: several fields in a declared order, each with its own
// direction and null placement, answered by one ordered run.
//
// These pin what a caller relies on: an index serves its order and exactly its
// reverse, an equality on its leading fields seeks rather than filters, it is
// complete however it was built, and nothing of a dropped one is ever read.
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

// Ties, a null, an absent field, an object where a price should be, and a
// document with no status at all.
const ROWS = [
  ["a", { status: "open", price: 30 }],
  ["b", { status: "closed", price: 10 }],
  ["c", { status: "open", price: null }],
  ["d", { status: "open", price: 10 }],
  ["e", { price: 20 }],
  ["f", { status: "closed", price: 25 }],
  ["g", { status: "open" }],
  ["h", { status: "closed", price: { amount: 1 } }],
  ["i", { status: "open", price: 30 }],
];
const BY_STATUS_PRICE = [{ path: "status" }, { path: "price", direction: "desc" }];
// Status ascending, then price descending; no value last in each field, and
// documents equal on both in insertion order.
const FORWARD = ["f", "b", "h", "a", "i", "d", "c", "g", "e"];
// Every direction and null placement flipped: the same index, read backwards.
const FLIPPED = [
  { path: "status", direction: "desc", nulls: "first" },
  { path: "price", direction: "asc", nulls: "first" },
];

for (const [engine, open] of engines) {
  const setup = (t, body, { index = true } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `zv-composite-${engine}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* open(dir);
      const docs = documentsFor(store, "t1");
      yield* docs.createCollection({ name: "items" });
      yield* docs.createCollection({ name: "plain" });
      for (const [id, data] of ROWS) {
        yield* docs.insert({ collection: "items", id, data });
        yield* docs.insert({ collection: "plain", id, data });
      }
      // Created over documents already there, so the rewrite is what fills it.
      if (index) yield* docs.createIndex({ collection: "items", name: "by_status_price", fields: BY_STATUS_PRICE });
      return yield* body(docs, store);
    })));
  };
  const ids = (found) => found.map((d) => d.id);
  const find = (docs, input) => Effect.map(docs.findMany({ collection: "items", ...input }), ids);
  const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
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

  test(`${engine}: an index pages by several fields, each with its own direction and null placement`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      for (const limit of [1, 2, 4, 100]) {
        const pages = yield* walk(docs, { orderBy: BY_STATUS_PRICE, limit });
        assert.deepEqual(pages.flat(), FORWARD, `${limit} per page`);
        assert.ok(pages.every((page) => page.length > 0), `an empty page at ${limit} per page`);
      }
      assert.deepEqual(yield* find(docs, { orderBy: BY_STATUS_PRICE }), FORWARD);
      assert.deepEqual(yield* find(docs, { orderBy: BY_STATUS_PRICE, limit: 3, offset: 2 }), FORWARD.slice(2, 5));
      // The same order sorted in memory, where no index exists, agrees.
      assert.deepEqual(ids(yield* docs.findMany({ collection: "plain", orderBy: BY_STATUS_PRICE })), FORWARD);
    })));

  test(`${engine}: the index read backwards serves exactly the opposite order, null placements included`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.deepEqual((yield* walk(docs, { orderBy: FLIPPED, limit: 2 })).flat(), [...FORWARD].reverse());
      // Flipping the directions but not where nulls go is a different order,
      // which this index does not hold: a page refuses it, findMany sorts it.
      const opposite = [{ path: "status", direction: "desc" }, { path: "price" }];
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: opposite })), "UnsupportedOrdering");
      assert.deepEqual(yield* find(docs, { orderBy: opposite }), ["d", "a", "i", "c", "g", "b", "f", "h", "e"]);
    })));

  test(`${engine}: an equality on the leading field seeks into the index`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const open = [{ path: "status", value: "open" }];
      assert.deepEqual((yield* walk(docs, { where: open, orderBy: [{ path: "price", direction: "desc" }], limit: 2 })).flat(),
        ["a", "i", "d", "c", "g"]);
      assert.deepEqual((yield* walk(docs, { where: open, orderBy: [{ path: "price", nulls: "first" }], limit: 2 })).flat(),
        ["g", "c", "d", "i", "a"]);
      const pricedOpen = [...open, { path: "price", op: "gte", value: 10 }];
      assert.deepEqual(yield* find(docs, { where: pricedOpen, orderBy: [{ path: "price", direction: "desc" }] }),
        ["a", "i", "d"]);
    })));

  test(`${engine}: an order no index serves is refused by a page and sorted by findMany`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const orderBy = [{ path: "price" }, { path: "status" }];
      const error = yield* Effect.flip(docs.findPage({ collection: "items", orderBy }));
      assert.equal(error._tag, "UnsupportedOrdering");
      assert.match(error.reason, /price asc nulls last, status asc nulls last needs a composite index/);
      // Documents with no price still sort by status among themselves.
      assert.deepEqual(yield* find(docs, { orderBy }), ["b", "d", "e", "f", "a", "i", "h", "c", "g"]);
    })));

  test(`${engine}: without the index, the same order is refused`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: BY_STATUS_PRICE })), "UnsupportedOrdering");
    }), { index: false }));

  test(`${engine}: writes after the index keep it current`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      yield* docs.insert({ collection: "items", id: "j", data: { status: "closed", price: 99 } });
      yield* docs.update({ collection: "items", id: "d", data: { price: 50 } });
      yield* docs.delete({ collection: "items", id: "a" });
      yield* docs.update({ collection: "items", id: "e", data: { status: "closed" } });
      const expected = ["j", "f", "e", "b", "h", "d", "i", "c", "g"];
      assert.deepEqual((yield* walk(docs, { orderBy: BY_STATUS_PRICE, limit: 3 })).flat(), expected);
      assert.deepEqual(yield* find(docs, { orderBy: BY_STATUS_PRICE }), expected);
    })));

  test(`${engine}: a dropped index stops answering, and one recreated under its name starts clean`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      assert.equal(yield* docs.dropIndex({ collection: "items", name: "by_status_price" }), true);
      assert.equal(yield* docs.dropIndex({ collection: "items", name: "by_status_price" }), false);
      assert.equal(yield* tagOf(docs.findPage({ collection: "items", orderBy: BY_STATUS_PRICE })), "UnsupportedOrdering");

      const byPrice = [{ path: "price" }, { path: "status" }];
      const index = yield* docs.createIndex({ collection: "items", name: "by_status_price", fields: byPrice });
      assert.equal(index.state, "ready");
      // Postings the first index left behind would show up here as extra or misplaced rows.
      assert.deepEqual((yield* walk(docs, { orderBy: byPrice, limit: 2 })).flat(),
        ids(yield* docs.findMany({ collection: "plain", orderBy: byPrice })));

      const items = (yield* docs.listCollections).find((c) => c.name === "items");
      assert.deepEqual(items.indexes, [{
        name: "by_status_price",
        fields: [
          { path: "price", direction: "asc", nulls: "last" },
          { path: "status", direction: "asc", nulls: "last" },
        ],
        state: "ready",
      }]);
    })));

  test(`${engine}: definitions are checked, and asking twice returns the same index`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const again = yield* docs.createIndex({ collection: "items", name: "by_status_price", fields: BY_STATUS_PRICE });
      assert.equal(again.state, "ready");
      const create = (name, fields, collection = "items") => tagOf(docs.createIndex({ collection, name, fields }));
      assert.equal(yield* create("by_status_price", [{ path: "price" }]), "IndexExists");
      assert.equal(yield* create("none", []), "InvalidIndex");
      assert.equal(yield* create("twice", [{ path: "a" }, { path: "a" }]), "InvalidIndex");
      assert.equal(yield* create("bad name", [{ path: "a" }]), "InvalidIndex");
      assert.equal(yield* create("sideways", [{ path: "a", direction: "up" }]), "InvalidIndex");
      assert.equal(yield* create("gap", [{ path: "a..b" }]), "InvalidIndex");
      assert.equal(yield* create("wide", Array.from({ length: 9 }, (_, i) => ({ path: `f${i}` }))), "InvalidIndex");
      assert.equal(yield* create("lost", [{ path: "a" }], "nowhere"), "CollectionNotFound");

      // A collection can start with its indexes, ready before its first document.
      const fresh = yield* docs.createCollection({
        name: "fresh", indexes: [{ name: "by_status_price", fields: BY_STATUS_PRICE }],
      });
      assert.equal(fresh.indexes[0].state, "ready");
      for (const [id, data] of ROWS) yield* docs.insert({ collection: "fresh", id, data });
      assert.deepEqual(ids(yield* docs.findMany({ collection: "fresh", orderBy: BY_STATUS_PRICE })), FORWARD);
      assert.equal(yield* tagOf(docs.createCollection({
        name: "doubled", indexes: [{ name: "x", fields: [{ path: "a" }] }, { name: "x", fields: [{ path: "b" }] }],
      })), "InvalidIndex");
    })));

  test(`${engine}: a cursor does not outlive the index it was reading`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const { next } = yield* docs.findPage({ collection: "items", orderBy: BY_STATUS_PRICE, limit: 2 });
      yield* docs.dropIndex({ collection: "items", name: "by_status_price" });
      yield* docs.createIndex({ collection: "items", name: "by_status_price", fields: BY_STATUS_PRICE });
      const error = yield* Effect.flip(docs.findPage({ collection: "items", orderBy: BY_STATUS_PRICE, after: next }));
      assert.equal(error._tag, "CursorMismatch");
      assert.match(error.reason, /indexes changed/);
    })));

  test(`${engine}: one field puts no value first when asked, in either direction`, (t) =>
    setup(t, (docs) => Effect.gen(function* () {
      const plain = (orderBy) => Effect.map(docs.findMany({ collection: "plain", orderBy }), ids);
      const pagedPlain = (orderBy) => Effect.gen(function* () {
        const seen = [];
        let after;
        for (;;) {
          const page = yield* docs.findPage({ collection: "plain", orderBy, limit: 2, ...(after === undefined ? {} : { after }) });
          seen.push(...ids(page.documents));
          if (page.next === undefined) return seen;
          after = page.next;
        }
      });
      const ascending = [{ path: "price", nulls: "first" }];
      const descending = [{ path: "price", direction: "desc", nulls: "first" }];
      assert.deepEqual(yield* plain(ascending), ["c", "g", "h", "b", "d", "e", "f", "a", "i"]);
      assert.deepEqual(yield* pagedPlain(ascending), yield* plain(ascending));
      assert.deepEqual(yield* plain(descending), ["c", "g", "h", "i", "a", "f", "e", "d", "b"]);
      assert.deepEqual(yield* pagedPlain(descending), yield* plain(descending));
    })));

  test(`${engine}: sealing and reindexing leave the index answering as it did`, (t) =>
    setup(t, (docs, store) => Effect.gen(function* () {
      yield* store.sealPostings;
      assert.deepEqual((yield* walk(docs, { orderBy: BY_STATUS_PRICE, limit: 2 })).flat(), FORWARD);
      yield* store.reindexLenses;
      assert.deepEqual((yield* walk(docs, { orderBy: FLIPPED, limit: 3 })).flat(), [...FORWARD].reverse());
    })));
}
