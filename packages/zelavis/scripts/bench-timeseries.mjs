// What a time-series window costs: ingest, then windows of every width.
//
//   POINTS=20000 node scripts/bench-timeseries.mjs
//
// A window is a range over the points' own instants, so its cost should follow
// what it returns rather than how wide it is.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const POINTS = Number(process.env.POINTS ?? 20000);
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 1);

const median = async (runs, fn) => {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

const dir = mkdtempSync(join(tmpdir(), "zv-bench-ts-"));
try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* makeDatabase({
      partitionMap: partitionMapFor(["s0"]),
      openShard: (shard) => makeNodeSqliteStore(shard, dir),
    });
    const tenant = db.forTenant("acme");
    yield* tenant.documents.createCollection({ name: "readings" });
    yield* tenant.timeSeries.define({
      name: "usage",
      map: (event) =>
        event.type !== "document.upserted" ? null : {
          timestamp: event.payload.data.at,
          value: event.payload.data.value,
          tags: { region: event.payload.data.region },
        },
    });
    for (let i = 0; i < POINTS; i++) {
      yield* tenant.documents.insert({
        collection: "readings",
        id: `r${i}`,
        data: { at: BASE + i * HOUR, value: i, region: i % 4 === 0 ? "eu" : "us" },
      });
    }
    const started = performance.now();
    const ingested = yield* tenant.timeSeries.ingest("usage");
    const ingestMs = performance.now() - started;
    const usage = tenant.timeSeries.get("usage");
    const run = (effect) => () => Effect.runPromise(effect);
    const window = (hours) => ({ start: BASE, end: BASE + hours * HOUR });

    console.log(`\nOver ${ingested.points} points, one an hour (node:sqlite, median of 5, warm)`);
    console.log(`  ingest                                   ${(ingested.points / (ingestMs / 1000)).toFixed(0).padStart(8)} points/s`);
    const rows = [
      ["range, one day of it", run(usage.range(window(24)))],
      ["range, one month", run(usage.range(window(24 * 30)))],
      ["range, the whole series", run(usage.range(window(POINTS)))],
      ["range, wider than the series on both sides", run(usage.range({ start: BASE - 1e12, end: BASE + 1e12 }))],
      ["aggregate count, one month", run(usage.aggregate({ op: "count", ...window(24 * 30) }))],
      ["range, one month filtered by tag", run(usage.range({ ...window(24 * 30), tags: { region: "eu" } }))],
    ];
    for (const [label, fn] of rows) {
      console.log(`  ${label.padEnd(42)} ${(yield* Effect.promise(() => median(5, fn))).toFixed(1).padStart(8)}ms`);
    }
  })));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
