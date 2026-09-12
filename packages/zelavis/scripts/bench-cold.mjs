// Measures each engine with a cold page cache.
//
// Every earlier number was taken with the whole database resident in memory,
// which is the regime where a B+tree and an LSM tree behave most alike. Here the
// cache is evicted between writing and reading by streaming a file larger than
// the memory available to hold it, so the first read of each query has to reach
// the disk. Cold against warm on the same data is the comparison; the absolute
// milliseconds are specific to this machine's SSD.
import { execSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { makeLibsqlStore } from "../dist/db/engines/libsql.js";
import { makeRocksdbStore } from "../dist/db/engines/rocksdb.js";
import { makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { makeLmdbStore } from "../dist/db/engines/lmdb.js";

const N = Number(process.env.N ?? 500000);
const BATCH = 2000;
const EVICT_GB = Number(process.env.EVICT_GB ?? 6);
const SCRATCH = join(tmpdir(), "zv-evict.bin");

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
const ms = (a, b) => Number(b - a) / 1e6;
const now = () => process.hrtime.bigint();

const makeScratch = async () => {
  if (existsSync(SCRATCH) && statSync(SCRATCH).size >= EVICT_GB * 2 ** 30) return;
  const chunk = Buffer.alloc(8 * 2 ** 20, 7);
  const out = createWriteStream(SCRATCH);
  for (let written = 0; written < EVICT_GB * 2 ** 30; written += chunk.length) {
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
};

/** Streams a file bigger than the cache, so the database is pushed out of it. */
const evictCache = async () => {
  await new Promise((resolve, reject) => {
    const stream = createReadStream(SCRATCH, { highWaterMark: 8 * 2 ** 20 });
    stream.on("data", () => {});
    stream.on("end", resolve);
    stream.on("error", reject);
  });
};

const engines = [
  ["node-sqlite", (dir) => makeNodeSqliteStore("bench", dir)],
  ["libsql", (dir) => makeLibsqlStore("bench", { directory: dir })],
  ["rocksdb-js", (dir) => makeRocksdbJsStore("bench", dir)],
  ["rocksdb", (dir) => makeRocksdbStore("bench", dir)],
  ["lmdb", (dir) => makeLmdbStore("bench", dir)],
].filter(([n]) => !process.env.ENGINES || process.env.ENGINES.split(",").includes(n));

await makeScratch();
const results = [];

for (const [name, open] of engines) {
  const dir = mkdtempSync(join(tmpdir(), `zv-cold-${name}-`));
  const row = { engine: name };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* open(dir);
        yield* Effect.promise(async () => {
          const rand = rnd(42);
          const pick = (a) => a[Math.floor(rand() * a.length)];
          let t = now();
          for (let start = 0; start < N; start += BATCH) {
            const rows = [];
            for (let k = 0; k < BATCH && start + k < N; k++) {
              const words = [pick(WORDS), pick(WORDS)];
              rows.push({
                bytes: enc.encode(JSON.stringify({ i: start + k, t: words.join(" ") })),
                manifest: {
                  terms: words.map((w) => ["title", w]),
                  columns: [["region", pick(REGIONS)], ["status", pick(STATUS)]],
                  measures: [["visits", Math.floor(rand() * 50000)]],
                  edges: [],
                },
              });
            }
            await Effect.runPromise(
              store.transact((txn) =>
                Effect.forEach(rows, (r, k) => txn.put(asSeq(start + k + 1), r.bytes, r.manifest),
                  { discard: true })),
            );
          }
          row.ingestMs = Math.round(ms(t, now()));

          const query = and(term("title", "atlas"), equals("region", "eu-west"));
          const runQuery = () =>
            Effect.runPromise(Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c].length));
          const scan = () =>
            Effect.runPromise(Effect.map(Stream.runCollect(store.resolve(equals("region", "eu-west"))), (c) => [...c].length));

          await evictCache();

          t = now(); row.coldScanMs = +ms(t, now()).toFixed(1);
          t = now(); row.coldScanRows = await scan(); row.coldScanMs = +ms(t, now()).toFixed(1);
          t = now(); await runQuery(); row.coldCrossMs = +ms(t, now()).toFixed(1);
          t = now();
          for (let i = 1; i <= 500; i++) await Effect.runPromise(store.read(asSeq(i * 7)));
          row.coldPointUs = +((ms(t, now()) * 1000) / 500).toFixed(1);

          // Warm: the same queries with everything now resident again.
          await scan(); await runQuery();
          t = now(); await scan(); row.warmScanMs = +ms(t, now()).toFixed(1);
          t = now(); await runQuery(); row.warmCrossMs = +ms(t, now()).toFixed(1);
          t = now();
          for (let i = 1; i <= 500; i++) await Effect.runPromise(store.read(asSeq(i * 7)));
          row.warmPointUs = +((ms(t, now()) * 1000) / 500).toFixed(1);
        });
      }),
    ),
  );
  try { row.diskMb = Math.round(execSync(`du -sk ${dir}`).toString().split(/\s+/)[0] / 1024); } catch {}
  rmSync(dir, { recursive: true, force: true });
  results.push(row);
  console.error(`${name} done`);
}

rmSync(SCRATCH, { force: true });
console.log(JSON.stringify({ objects: N, evictGb: EVICT_GB, results }, null, 2));
