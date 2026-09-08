// Does sealing actually buy anything? Measures the same queries against the
// same data, live tier versus sealed tier, plus what the two cost on disk.
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const N = Number(process.env.N ?? 200000);
const enc = new TextEncoder();
const dir = mkdtempSync(join(tmpdir(), "zv-seal-bench-"));

const bytesOnDisk = () =>
  readdirSync(dir).reduce((total, f) => total + statSync(join(dir, f)).size, 0);

const ms = async (label, run) => {
  const started = process.hrtime.bigint();
  const out = await run();
  const took = Number(process.hrtime.bigint() - started) / 1e6;
  return { label, took, out };
};

// Each phase opens and closes the store, because a size taken while it is open
// is measuring the write-ahead log rather than what the data costs at rest.
const phase = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* makeNodeSqliteStore("bench", dir);
    return yield* body(store);
  })));

const load = (store) =>
  Effect.gen(function* () {
    const started = Date.now();
  for (let seq = 1; seq <= N; seq++) {
    yield* store.transact((txn) =>
      txn.put(
        asSeq(seq),
        enc.encode(JSON.stringify({ seq })),
        {
          // One very wide term, one selective one, one column of four values.
          terms: [["kind", "post"], ["tag", `t${seq % 5000}`]],
          columns: [["region", `r${seq % 4}`]],
          measures: [],
          edges: [],
        },
        { namespace: "doc/bench/posts", key: `p${seq}` },
      ));
    if (seq % 25000 === 0) process.stderr.write(`  wrote ${seq}\n`);
    }
    console.log(`wrote ${N} objects in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  });

const measure = (store) =>
  Effect.gen(function* () {
  const count = (q) =>
    Effect.gen(function* () {
      let n = 0;
      yield* Stream.runForEach(store.resolve(q), () => Effect.sync(() => { n += 1; }));
      return n;
    });
  const queries = [
    ["wide term        (kind=post)", term("kind", "post")],
    ["selective term   (tag=t42)", term("tag", "t42")],
    ["wide column      (region=r1)", equals("region", "r1")],
    ["narrow ∩ wide", and(term("tag", "t42"), term("kind", "post"))],
  ];

  const run = () =>
    Effect.forEach(queries, ([label, q]) =>
      Effect.promise(() => ms(label, () => Effect.runPromise(count(q)))));

    // Warm, so this measures the representation and not the first page fault.
    yield* run();
    return yield* run();
  });

const report = (live, blobs, sealed, sealMs, liveBytes, sealedBytes) => {
  console.log(`\nsealed ${sealed.postings} postings into ${sealed.segments} segments in ${(sealMs / 1000).toFixed(1)}s\n`);
  console.log("query                          live ms   sealed ms   speedup   rows");
  for (let i = 0; i < live.length; i++) {
    const a = live[i], b = blobs[i];
    console.log(
      `${a.label.padEnd(30)} ${a.took.toFixed(2).padStart(7)} ${b.took.toFixed(2).padStart(11)} ` +
      `${(a.took / b.took).toFixed(1).padStart(8)}×  ${String(a.out).padStart(7)}`,
    );
    if (a.out !== b.out) throw new Error(`row count changed: ${a.out} -> ${b.out}`);
  }
  console.log(`\nat rest: live ${(liveBytes / 1e6).toFixed(1)} MB -> sealed ${(sealedBytes / 1e6).toFixed(1)} MB`);
  console.log("(SQLite keeps freed pages rather than returning them, so the sealed");
  console.log(" figure is the file, not the data — the segment blobs themselves are");
  console.log(` ${(sealed.segments * 21 / 1e6).toFixed(1)}-${(sealed.segments * 8193 / 1e6).toFixed(1)} MB depending on their density.)`);
};

try {
  await phase(load);
  const live = await phase(measure);
  const liveBytes = bytesOnDisk();

  const sealStarted = Date.now();
  const sealed = await phase((store) => store.sealPostings);
  const sealMs = Date.now() - sealStarted;
  const sealedBytes = bytesOnDisk();

  const blobs = await phase(measure);
  report(live, blobs, sealed, sealMs, liveBytes, sealedBytes);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
