// Commits a second through the store, by durability and by how many Tenants
// write at once to one SQLite shard.
//
//   node scripts/bench-commits.mjs                 (2,000 commits per run)
//   COMMITS=10000 node scripts/bench-commits.mjs
//   COMMITS=20000 BODY=4000 node scripts/bench-commits.mjs   (enough log to cross checkpoints)
//
// `loopMaxMs` is the longest the event loop could not run anything else: what a
// request arriving at the worst moment would have waited.
//
// Each Tenant is its own partition, so its commits are serialized by its own
// writer permit and only Tenants sharing the shard can share a flush. The
// numbers are one machine's: read the ratios between rows. On macOS `power`
// pays for F_FULLFSYNC, a real flush of the drive's cache, on every flush.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Effect } from "effect";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const COMMITS = Number(process.env.COMMITS ?? 2000);
const BODY = Number(process.env.BODY ?? 400);
const body = new TextEncoder().encode(JSON.stringify({ title: "a note of ordinary size", body: "x".repeat(BODY) }));
const manifest = { terms: [["title", "note"]], columns: [["status", "open"]], measures: [], edges: [] };

const run = (durability, tenants) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-bench-commits-"));
  const perTenant = Math.max(1, Math.floor(COMMITS / tenants));
  const delay = monitorEventLoopDelay({ resolution: 1 });
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shard = yield* makeNodeSqliteStore("s0", dir, { durability });
    const partitions = Array.from({ length: tenants }, (_, index) => shard.partition(`t${index}`));
    // A first commit each, outside the timing: it creates the partition.
    yield* Effect.forEach(partitions, (store) => store.transact((txn) => txn.put(1, body, manifest, { namespace: "notes", key: "0" })), { discard: true });
    delay.enable();
    const started = performance.now();
    yield* Effect.forEach(partitions, (store) => Effect.forEach(
      Array.from({ length: perTenant }, (_, index) => index + 2),
      (seq) => store.transact((txn) => txn.put(seq, body, manifest, { namespace: "notes", key: String(seq) })),
      { discard: true },
    ), { concurrency: "unbounded", discard: true });
    const elapsed = performance.now() - started;
    delay.disable();
    return { durability, tenants, commits: perTenant * tenants, perSecond: Math.round((perTenant * tenants) / (elapsed / 1000)), loopP99Ms: +(delay.percentile(99) / 1e6).toFixed(2), loopMaxMs: +(delay.max / 1e6).toFixed(2) };
  }))).finally(() => rmSync(dir, { recursive: true, force: true }));
};

const rows = [];
const durabilities = (process.env.DURABILITY ?? "crash,power").split(",");
const tenantCounts = (process.env.TENANTS ?? "1,8,32").split(",").map(Number);
for (const durability of durabilities) {
  for (const tenants of tenantCounts) rows.push(await run(durability, tenants));
}
console.table(rows);
