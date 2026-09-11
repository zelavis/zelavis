// Ordering across tenants: a merged page against gathering everything.
//
//   TENANTS=20 PER=1000 node scripts/bench-scatter.mjs
//
// Every tenant is ordered on its own shard, and a scatter merges those runs by
// value. What a page costs should follow the page and the number of tenants,
// not how many documents they hold; gathering and sorting is the alternative.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const TENANTS = Number(process.env.TENANTS ?? 20);
const PER = Number(process.env.PER ?? 1000);

const median = async (runs, fn) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

const dir = mkdtempSync(join(tmpdir(), "zv-bench-scatter-"));
try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0", "s1", "s2", "s3"]),
      openShard: (shard) => makeNodeSqliteStore(shard, dir),
    });
    for (let t = 0; t < TENANTS; t++) {
      const docs = db.forTenant(`tenant${String(t).padStart(3, "0")}`).documents;
      yield* docs.createCollection({ name: "items" });
      for (let i = 0; i < PER; i++) {
        yield* docs.insert({ collection: "items", id: `d${i}`, data: { price: (i * 7919 + t * 104729) % 1000003 } });
      }
    }
    const orderBy = [{ path: "price" }];
    const run = (effect) => () => Effect.runPromise(effect);
    const walk = (pages) => Effect.gen(function* () {
      let after;
      for (let p = 0; p < pages; p++) {
        const page = yield* db.scatter.findPage({ collection: "items", orderBy, limit: 50, ...(after ? { after } : {}) });
        after = page.next;
      }
    });
    const first = yield* db.scatter.findPage({ collection: "items", orderBy, limit: 50 });
    const rows = [
      ["scatter.findPage, first 50 by price", run(db.scatter.findPage({ collection: "items", orderBy, limit: 50 }))],
      ["scatter.findPage, 20 pages of 50 by price", run(walk(20))],
      ["scatter.findMany, first 50 by price", run(db.scatter.findMany({ collection: "items", orderBy, limit: 50 }))],
      ["scatter.findMany, all by price (gather and sort)", run(db.scatter.findMany({ collection: "items", orderBy }))],
    ];
    console.log(`\nAcross ${TENANTS} tenants of ${PER} documents on 4 shards (node:sqlite, median of 5, warm)`);
    for (const [label, fn] of rows) {
      console.log(`  ${label.padEnd(50)} ${(yield* Effect.promise(() => median(5, fn))).toFixed(1).padStart(8)}ms`);
    }
    const read = first.legs.reduce((n, leg) => n + leg.read, 0);
    console.log(`\n  a first page of 50 read ${read} documents from ${first.legs.length} tenants on ${first.shards} shards`);
  })));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
