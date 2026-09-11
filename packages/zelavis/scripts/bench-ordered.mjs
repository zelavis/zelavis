// The scalar lens: what it costs to write, and what it answers, sealed or not.
//
//   N=50000 node scripts/bench-ordered.mjs
//
// One lens answers equality, ranges and order, so every scalar field is one
// posting. Reads are measured twice: with every posting live, and after
// `sealPostings` has folded them into segment blobs, which is the state a
// maintained store is in — and the one a merged lens had to keep fast.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { asSeq, documentsFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const N = Number(process.env.N ?? 20000);
const FIELDS = 5;
const enc = new TextEncoder();

const sizeOf = (dir) => readdirSync(dir, { recursive: true })
  .map((name) => statSync(join(dir, name))).filter((s) => s.isFile()).reduce((n, s) => n + s.size, 0);

const median = async (runs, fn) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

const withStore = async (body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-bench-ordered-"));
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      return yield* body(yield* makeNodeSqliteStore("bench", dir), dir);
    })));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------- write cost
const written = await withStore((store, dir) => Effect.gen(function* () {
  const started = performance.now();
  for (let seq = 1; seq <= N; seq++) {
    const values = Array.from({ length: FIELDS }, (_, f) => (seq * (f + 7919)) % 100000);
    yield* store.transact((txn) => txn.put(asSeq(seq), enc.encode(JSON.stringify(values)), {
      terms: [],
      columns: values.map((v, f) => [`field${f}`, v]),
      measures: [],
      edges: [],
    }));
  }
  const ms = performance.now() - started;
  return { perSec: Math.round(N / (ms / 1000)), bytesPerObject: Math.round(sizeOf(dir) / N) };
}));
console.log(`\nWrite cost, ${N} objects x ${FIELDS} scalar fields, one transaction each (node:sqlite)`);
console.log(`  one scalar lens          ${String(written.perSec).padStart(7)} objects/s  ${String(written.bytesPerObject).padStart(5)} B/object`);

// ------------------------------------------------------------------- reads
await withStore((store) => Effect.gen(function* () {
  const docs = documentsFor(store, "t1");
  yield* docs.createCollection({ name: "items" });
  for (let i = 0; i < N; i++) {
    yield* docs.insert({ collection: "items", id: `d${i}`, data: {
      price: (i * 7919) % 1000003,
      category: i % 20,
      name: `n${(i * 104729) % N}`,
    } });
  }
  const run = (effect) => () => Effect.runPromise(effect);
  const q = (input) => ({ collection: "items", ...input });
  // The one query both an index and a single field's lens can answer: first
  // without the index, then with it.
  const seek = q({ where: [{ path: "category", value: 3 }], orderBy: [{ path: "price", direction: "desc" }], limit: 50 });
  const seekByLens = yield* Effect.promise(() => median(5, run(docs.findPage(seek))));
  const built = performance.now();
  yield* docs.createIndex({ collection: "items", name: "by_price_name", fields: [{ path: "price" }, { path: "name" }] });
  yield* docs.createIndex({
    collection: "items", name: "by_category_price",
    fields: [{ path: "category" }, { path: "price", direction: "desc" }],
  });
  const buildMs = performance.now() - built;
  const walkTwo = (pages) => Effect.gen(function* () {
    let after;
    for (let p = 0; p < pages; p++) {
      const page = yield* docs.findPage(q({ orderBy: [{ path: "price" }, { path: "name" }], limit: 50, ...(after ? { after } : {}) }));
      after = page.next;
    }
  });
  const walkPages = (pages, direction) => Effect.gen(function* () {
    let after;
    for (let p = 0; p < pages; p++) {
      const page = yield* docs.findPage(q({ orderBy: [{ path: "price", direction }], limit: 50, ...(after ? { after } : {}) }));
      after = page.next;
    }
  });
  const rows = [
    ["findPage, first 50 by price, ascending", run(docs.findPage(q({ orderBy: [{ path: "price" }], limit: 50 })))],
    ["findPage, first 50 by price, descending", run(docs.findPage(q({ orderBy: [{ path: "price", direction: "desc" }], limit: 50 })))],
    ["findPage, 20 pages of 50 by price", run(walkPages(20, "asc"))],
    ["findMany, category = 3 (5% of documents)", run(docs.findMany(q({ where: [{ path: "category", value: 3 }] })))],
    ["findMany, category = 3 and price < 50%", run(docs.findMany(q({ where: [{ path: "category", value: 3 }, { path: "price", op: "lt", value: 500000 }] })))],
    ["findMany, price < 1% of range", run(docs.findMany(q({ where: [{ path: "price", op: "lt", value: 10000 }] })))],
    ["findMany, price < 50% of range", run(docs.findMany(q({ where: [{ path: "price", op: "lt", value: 500000 }] })))],
    ["findPage, first 50 by price then name (index)", run(docs.findPage(q({ orderBy: [{ path: "price" }, { path: "name" }], limit: 50 })))],
    ["findPage, 20 pages of 50 by price then name (index)", run(walkTwo(20))],
    ["findPage, category = 3, first 50 by price desc (index)", run(docs.findPage(seek))],
    ["findMany, first 50 by category then name (in memory)", run(docs.findMany(q({ orderBy: [{ path: "category" }, { path: "name" }], limit: 50 })))],
  ];
  const live = [];
  for (const [, fn] of rows) live.push(yield* Effect.promise(() => median(5, fn)));
  yield* store.sealPostings;
  const sealed = [];
  for (const [, fn] of rows) sealed.push(yield* Effect.promise(() => median(5, fn)));
  console.log(`\nReads over ${N} documents (node:sqlite, median of 5, warm)`);
  console.log(`  ${"".padEnd(52)} ${"live".padStart(9)} ${"sealed".padStart(9)}`);
  rows.forEach(([label], i) => {
    console.log(`  ${label.padEnd(52)} ${live[i].toFixed(1).padStart(7)}ms ${sealed[i].toFixed(1).padStart(7)}ms`);
  });
  console.log(`\n  category = 3, first 50 by price desc, before its index: ${seekByLens.toFixed(1)}ms (price's lens, filtered)`);
  console.log(`  building both indexes over ${N} documents: ${(buildMs / 1000).toFixed(1)}s`);
}));
