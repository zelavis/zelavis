// Compares the storage engines on the workload the store actually runs.
//
//   node scripts/bench-engines.mjs          (25,000 objects)
//   N=100000 node scripts/bench-engines.mjs
//
// Every engine ingests byte-identical input in the same order into a fresh
// directory, so a difference is the engine rather than the data. Numbers are
// from one machine with everything in page cache: read the ratios, not the
// milliseconds, and note that nothing here exercises a working set larger than
// memory, which is where these engines differ most.
//
// Measures the workload the store actually runs:
// ingest with every lens written, posting scans, the cross-model intersection,
// ordered pages, point lookups, and size on disk. Same data, same order, fresh
// directory each.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { runEngines } from "./bench-engine.mjs";

const N = Number(process.env.N ?? 25000);
const BATCH = 1000;

const rnd = (s) => () => {
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const REGIONS = ["eu-west", "eu-central", "us-east", "us-west", "ap-south", "sa-east"];
const STATUS = ["active", "suspended", "trial"];
const WORDS = "atlas beacon cobalt delta ember falcon granite harbor indigo juniper".split(" ");
const enc = new TextEncoder();

// Generated once so every engine ingests byte-identical input.
const build = () => {
  const rand = rnd(42);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const rows = [];
  for (let i = 0; i < N; i++) {
    const words = [pick(WORDS), pick(WORDS)];
    const region = pick(REGIONS);
    rows.push({
      bytes: enc.encode(JSON.stringify({ i, region, title: words.join(" ") })),
      manifest: {
        terms: words.map((w) => ["title", w]),
        columns: [["region", region], ["status", pick(STATUS)]],
        measures: [["visits", Math.floor(rand() * 50000)]],
        edges: [["uses", 1_000_000 + Math.floor(rand() * 300)]],
      },
    });
  }
  return rows;
};

const rows = build();
const ms = (a, b) => Number(b - a) / 1e6;
const now = () => process.hrtime.bigint();

const sizeOf = (dir) => {
  try { return execSync(`du -sk ${dir}`).toString().split(/\s+/)[0] * 1; } catch { return 0; }
};

const run = (effect) => Effect.runPromise(effect);

const timed = async (fn, reps = 5) => {
  await fn();
  const t0 = now();
  let out;
  for (let i = 0; i < reps; i++) out = await fn();
  return { ms: +(ms(t0, now()) / reps).toFixed(2), out };
};

// Plain async, so the store is driven the way a caller drives it.
const measureAll = async (store, row) => {
  let t = now();
  for (let start = 0; start < N; start += BATCH) {
    const slice = rows.slice(start, start + BATCH);
    await run(
      store.transact((txn) =>
        Effect.forEach(slice, (r, k) =>
          txn.put(asSeq(start + k + 1), r.bytes, r.manifest,
            { namespace: "doc/bench/items", key: `k${start + k + 1}` }),
          { discard: true })),
    );
  }
  row.ingestMs = Math.round(ms(t, now()));
  row.ingestPerSec = Math.round(N / (row.ingestMs / 1000));

  const seqs = (q) => run(Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c].length));

  const wide = await timed(() => seqs(equals("region", "eu-west")));
  row.postingScanMs = wide.ms;
  row.postingRows = wide.out;

  const cross = await timed(() =>
    seqs(and(term("title", "atlas"), equals("region", "eu-west"), equals("status", "active"))));
  row.crossModelMs = cross.ms;
  row.crossRows = cross.out;

  const ordered = await timed(() =>
    run(store.ordered({ column: "visits", direction: "desc", limit: 100 })));
  row.orderedPageMs = ordered.ms;
  row.orderedRows = ordered.out.rows.length;

  const point = await timed(async () => {
    for (let i = 1; i <= 1000; i++) await run(store.read(asSeq(i)));
    return 1000;
  }, 2);
  row.pointReadMs = +(point.ms).toFixed(2);

  const lookup = await timed(async () => {
    for (let i = 1; i <= 1000; i++) await run(store.lookup("doc/bench/items", `k${i}`));
    return 1000;
  }, 2);
  row.identityLookupMs = +(lookup.ms).toFixed(2);

  const vector = await timed(() => run(store.measure("visits")), 3);
  row.measureMs = vector.ms;
};

const outputs = await runEngines("zv-bench", async ({ name, dir, open }) => {
  const row = { engine: name };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open();

        yield* Effect.promise(() => measureAll(store, row));
      }),
    ),
  );
  row.diskKb = sizeOf(dir);
  console.error(`${name} done`);
  console.log(JSON.stringify({ objects: N, results: [row] }, null, 2));
}, { collectJson: true });

if (!process.env.ZELAVIS_BENCH_ENGINE_CHILD) {
  const results = outputs.flatMap((output) => {
    try {
      return JSON.parse(output).results ?? [];
    } catch {
      return [];
    }
  });
  console.log(JSON.stringify({ objects: N, results }, null, 2));
}
