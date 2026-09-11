// The ordered lens: what it costs to write, and what it saves to read.
//
//   N=20000 node scripts/bench-ordered.mjs
//
// Cost: the same objects written with and without ordered postings, one
// transaction each, so the difference is the lens and nothing else. Saving:
// documents read in order through the lens against the in-memory sort that a
// two-field order still takes.
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
const ingest = (withOrdered) => withStore((store, dir) => Effect.gen(function* () {
  const started = performance.now();
  for (let seq = 1; seq <= N; seq++) {
    const values = Array.from({ length: FIELDS }, (_, f) => (seq * (f + 7919)) % 100000);
    yield* store.transact((txn) => txn.put(asSeq(seq), enc.encode(JSON.stringify(values)), {
      terms: [],
      columns: values.map((v, f) => [`field${f}`, String(v)]),
      measures: [],
      edges: [],
      ...(withOrdered ? { ordered: values.map((v, f) => [`field${f}`, v]) } : {}),
    }));
  }
  const ms = performance.now() - started;
  return { perSec: Math.round(N / (ms / 1000)), bytesPerObject: Math.round(sizeOf(dir) / N) };
}));

const without = await ingest(false);
const withLens = await ingest(true);
console.log(`\nWrite cost, ${N} objects x ${FIELDS} scalar fields, one transaction each (node:sqlite)`);
console.log(`  equality lens only       ${String(without.perSec).padStart(7)} objects/s  ${String(without.bytesPerObject).padStart(5)} B/object`);
console.log(`  equality + ordered lens  ${String(withLens.perSec).padStart(7)} objects/s  ${String(withLens.bytesPerObject).padStart(5)} B/object`);
console.log(`  ordered lens adds        ${(((without.perSec / withLens.perSec) - 1) * 100).toFixed(0).padStart(6)}% time      ${(((withLens.bytesPerObject / without.bytesPerObject) - 1) * 100).toFixed(0).padStart(4)}% disk`);

// --------------------------------------------------------------- read saving
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
    ["findMany, first 50 by one field (lens)", run(docs.findMany(q({ orderBy: [{ path: "price" }], limit: 50 })))],
    ["findMany, first 50 by two fields (sorted in memory)", run(docs.findMany(q({ orderBy: [{ path: "price" }, { path: "name" }], limit: 50 })))],
    ["findMany, price < 1% of range (lens)", run(docs.findMany(q({ where: [{ path: "price", op: "lt", value: 10000 }] })))],
    ["findMany, price < 50% of range (lens)", run(docs.findMany(q({ where: [{ path: "price", op: "lt", value: 500000 }] })))],
  ];
  console.log(`\nReads over ${N} documents (node:sqlite, median of 5, warm)`);
  for (const [label, fn] of rows) {
    const ms = yield* Effect.promise(() => median(5, fn));
    console.log(`  ${label.padEnd(52)} ${ms.toFixed(1).padStart(8)} ms`);
  }
}));
