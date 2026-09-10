/**
 * What `synchronous = NORMAL` actually promises, checked rather than assumed.
 *
 * In WAL mode that setting does not fsync on every commit, which trades two
 * different guarantees against each other, and the difference matters:
 *
 *   - A process dying — a crash, an OOM kill, a deploy that does not wait —
 *     loses nothing. The write-ahead log is in the operating system's page
 *     cache, and the operating system outlives the process.
 *   - The machine losing power can lose recently committed transactions,
 *     because those pages had not reached the disk. What it must never do is
 *     leave the database torn: a suffix may vanish, but what survives has to be
 *     whole.
 *
 * The first is what these tests assert directly, by killing a writer mid-flight
 * and holding the store to every commit it had already returned. The second is
 * simulated by truncating the log the way a power cut would, and asserting that
 * what comes back is a prefix of what was written rather than a database with
 * holes in it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { asSeq, equals, term } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { engineAvailable } from "./_engine-available.mjs";

const WRITER = fileURLToPath(new URL("./fixtures/durability-writer.mjs", import.meta.url));
const SEALER = fileURLToPath(new URL("./fixtures/durability-sealer.mjs", import.meta.url));
const decoder = new TextDecoder();

const receiptsIn = (path) => {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  // A kill can land mid-line; a torn last line was never a completed receipt.
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter((line) => line.length > 0).map(Number);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a writer and kill it once it has committed at least `atLeast` objects.
 *
 * SIGKILL, not SIGTERM: the process must get no chance to close the database,
 * flush anything, or run a shutdown hook, because a process that gets to tidy
 * up proves nothing about a process that does not.
 */
const killWriterAfter = async (engine, directory, atLeast) => {
  const receiptPath = join(directory, "receipts.log");
  const child = spawn(process.execPath, [WRITER, engine, directory, receiptPath, "100000"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += decoder.decode(chunk); });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (receiptsIn(receiptPath).length >= atLeast) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`writer never reached ${atLeast} commits. stderr:\n${stderr}`);
    }
    // Exiting early means it failed to start rather than that it finished.
    const raced = await Promise.race([exited, sleep(20)]);
    if (raced !== undefined) throw new Error(`writer exited early:\n${stderr}`);
  }

  child.kill("SIGKILL");
  const { signal } = await exited;
  assert.equal(signal, "SIGKILL", "the writer was killed rather than allowed to finish");

  const committed = receiptsIn(receiptPath);
  assert.ok(committed.length >= atLeast);
  return committed;
};

const openStore = (directory, body, engine = "sqlite") =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const store = yield* (engine === "rocksdb-js"
        ? (yield* Effect.promise(() => import("../dist/db/engines/rocksdb-js.js")))
            .makeRocksdbJsStore("acme", directory)
        : makeNodeSqliteStore("acme", directory));
      return yield* body(store);
    })),
  );

const seqs = (store, q) => Effect.map(Stream.runCollect(store.resolve(q)), (c) => [...c]);

/**
 * Every record the store holds is whole.
 *
 * A transaction is one batch, so a partially applied one — a payload with no
 * manifest, a posting with no payload, a record with no event behind it —
 * would mean the atomicity the whole store is built on does not survive a
 * crash.
 */
const assertCoherent = (store) =>
  Effect.gen(function* () {
    const records = yield* store.liveRecords;
    const byTerm = new Set(yield* seqs(store, term("kind", "post")));
    const logged = new Set();
    yield* Stream.runForEach(store.events.read({ limit: 1_000_000 }), (event) =>
      Effect.sync(() => logged.add(Number(event.seq))));

    for (const record of records) {
      const seq = Number(record.seq);
      assert.ok(record.manifest !== undefined, `record ${seq} has no manifest`);
      assert.equal(record.identity.key, `p${seq}`, `record ${seq} has the wrong identity`);
      assert.equal(JSON.parse(decoder.decode(record.bytes)).seq, seq,
        `record ${seq} has a payload from another object`);
      assert.ok(byTerm.has(seq), `record ${seq} exists but its lens does not list it`);
      assert.ok(logged.has(seq), `record ${seq} exists with no event behind it`);
    }
    return records.map((record) => Number(record.seq)).sort((a, b) => a - b);
  });

const engines = [
  ["sqlite", true],
  ["libsql", engineAvailable("libsql")],
  ["lmdb", engineAvailable("lmdb")],
  ["rocksdb-js", engineAvailable("@harperfast/rocksdb-js")],
];

// The discontinued `rocksdb` binding is absent while `rocksdb-js` is evaluated:
// this file reopens every engine in one process, and opening the old binding
// before the new one aborts inside libuv's timer. See db-kv-engines.test.mjs.

for (const [engine, available] of engines) {
  test(`${engine}: a killed writer loses no transaction it had already committed`,
    { skip: available ? false : `${engine} is not installed` },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), `zv-durable-${engine}-`));
      t.after(() => rmSync(dir, { recursive: true, force: true }));

      const committed = await killWriterAfter(engine, dir, 300);

      // Reopened by a different process than the one that died, which is the
      // situation a restart is actually in.
      const make = await import(
        `../dist/db/engines/${engine === "sqlite" ? "node-sqlite" : engine}.js`);
      const reopen =
        engine === "sqlite" ? make.makeNodeSqliteStore("acme", dir)
        : engine === "libsql" ? make.makeLibsqlStore("acme", { directory: dir })
        : engine === "rocksdb-js" ? make.makeRocksdbJsStore("acme", dir)
        : make.makeLmdbStore("acme", dir);

      const present = await Effect.runPromise(
        Effect.scoped(Effect.gen(function* () {
          return yield* assertCoherent(yield* reopen);
        })),
      );

      const found = new Set(present);
      const lost = committed.filter((seq) => !found.has(seq));
      assert.deepEqual(lost, [],
        `${lost.length} of ${committed.length} committed objects did not survive the kill`);
    });
}

test("a killed writer leaves lenses that agree with the log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-durable-replay-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const committed = await killWriterAfter("sqlite", dir, 300);

  await openStore(dir, (store) =>
    Effect.gen(function* () {
      // Appending to the log happens before projecting into the lenses, so a
      // crash can leave an event whose projection is missing but never a lens
      // row with no event. Re-deriving from the log alone is what makes that
      // claim checkable rather than aspirational.
      const before = {
        kind: yield* seqs(store, term("kind", "post")),
        tag: yield* seqs(store, term("tag", "t3")),
        region: yield* seqs(store, equals("region", "r2")),
      };
      assert.ok(before.kind.length >= committed.length);

      yield* store.rebuildLenses;

      assert.deepEqual(yield* seqs(store, term("kind", "post")), before.kind);
      assert.deepEqual(yield* seqs(store, term("tag", "t3")), before.tag);
      assert.deepEqual(yield* seqs(store, equals("region", "r2")), before.region);
    }),
  );
});

test("a writer killed after sealing leaves both tiers coherent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-durable-seal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const committed = await killWriterAfter("sqlite", dir, 300);

  await openStore(dir, (store) =>
    Effect.gen(function* () {
      const before = yield* seqs(store, term("kind", "post"));
      yield* store.sealPostings;
      assert.deepEqual(yield* seqs(store, term("kind", "post")), before,
        "recovered postings seal to the same answer");
      const present = yield* assertCoherent(store);
      assert.ok(committed.every((seq) => present.includes(seq)));
    }),
  );
});

/**
 * Where each engine keeps the log a power cut would tear.
 *
 * SQLite appends to one `-wal` file beside the database. RocksDB writes
 * numbered `.log` files inside its own directory — one per partition, and a new
 * one after every flush — so the live log is the newest of them. A writer
 * killed this early has flushed nothing, which the test below also checks.
 */
const logs = {
  sqlite: (at) =>
    readdirSync(at).filter((name) => name.endsWith("-wal")).map((name) => join(at, name)),
  "rocksdb-js": (at) =>
    readdirSync(join(at, "acme")).filter((name) => /^\d+\.log$/.test(name)).sort()
      .map((name) => join(at, "acme", name)),
};

for (const [engine, available] of [
  ["sqlite", true],
  ["rocksdb-js", engineAvailable("@harperfast/rocksdb-js")],
]) {
  test(`${engine}: a truncated write-ahead log costs a suffix, never a hole`,
    { skip: available ? false : `${engine} is not installed` },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), `zv-durable-power-${engine}-`));
      t.after(() => rmSync(dir, { recursive: true, force: true }));

      const committed = await killWriterAfter(engine, dir, 800);

      const walOf = logs[engine];
      assert.equal(walOf(dir).length, 1, "the writer left one write-ahead log to cut");

      // Power loss does not truncate at a record boundary, so neither does this:
      // the cut lands mid-record and the engine has to reject the partial
      // record on its checksum rather than read half of it as data.
      const survived = [];
      for (const fraction of [0.9, 0.5, 0.1, 0]) {
        const cut = mkdtempSync(join(tmpdir(), "zv-durable-cut-"));
        t.after(() => rmSync(cut, { recursive: true, force: true }));
        cpSync(dir, cut, { recursive: true });

        const wal = walOf(cut).at(-1);
        truncateSync(wal, Math.floor(statSync(wal).size * fraction) + 7);

        const present = await openStore(cut, assertCoherent, engine);

        // Objects were written in order, one transaction each, so losing the end
        // of the log must lose the highest identifiers — not scatter gaps
        // through the middle of what survives.
        assert.deepEqual(present, present.slice().sort((a, b) => a - b));
        for (let i = 0; i < present.length; i++) {
          assert.equal(present[i], i + 1,
            `a hole at ${i + 1}: recovery kept ${present.length} objects but not the first ${present.length}`);
        }
        assert.ok(present.length <= committed.length + 1);
        survived.push(present.length);
      }

      // Without this the test would pass just as happily if truncation did
      // nothing at all — if every commit had already been checkpointed or
      // flushed out of the log, cutting it would prove no more than copying it.
      assert.deepEqual(survived, survived.slice().sort((a, b) => b - a),
        `cutting more of the log recovered more of the data: ${survived.join(", ")}`);
      assert.ok(survived[survived.length - 1] < committed.length,
        `discarding the whole log still recovered ${survived[survived.length - 1]} of ` +
        `${committed.length} objects, so the log was not where they lived`);
    });
}

test("a seal killed halfway leaves every query answering as it did", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-durable-seal-kill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Enough postings that a seal takes far longer than the delay before the
  // kill, so the process really does die in the middle of one.
  const total = 30_000;
  const enc = new TextEncoder();
  const before = await openStore(dir, (store) =>
    Effect.gen(function* () {
      for (let seq = 1; seq <= total; seq++) {
        yield* store.transact((txn) =>
          txn.put(
            asSeq(seq),
            enc.encode(JSON.stringify({ seq })),
            {
              terms: [["kind", "post"], ["tag", `t${seq % 500}`]],
              columns: [["region", `r${seq % 4}`]],
              measures: [],
              edges: [],
            },
            { namespace: "doc/acme/posts", key: `p${seq}` },
          ));
      }
      return {
        kind: yield* seqs(store, term("kind", "post")),
        tag: yield* seqs(store, term("tag", "t7")),
        region: yield* seqs(store, equals("region", "r2")),
      };
    }));
  assert.equal(before.kind.length, total);

  const markerPath = join(dir, "seal.log");
  const child = spawn(process.execPath, [SEALER, dir, markerPath], { stdio: "inherit" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));

  const deadline = Date.now() + 30_000;
  const marker = () => {
    try {
      return readFileSync(markerPath, "utf8");
    } catch {
      return "";
    }
  };
  while (!marker().startsWith("sealing")) {
    if (Date.now() > deadline) throw new Error("the sealer never started");
    await sleep(5);
  }
  await sleep(80);
  child.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");
  assert.ok(!marker().includes("done"),
    "the seal finished before it could be interrupted; there is nothing to test here");

  await openStore(dir, (store) =>
    Effect.gen(function* () {
      // Some lens keys are now blobs and the rest are still live postings.
      // Reading both tiers is what makes that a state the store can simply be
      // in rather than one it has to be repaired out of.
      assert.deepEqual(yield* seqs(store, term("kind", "post")), before.kind);
      assert.deepEqual(yield* seqs(store, term("tag", "t7")), before.tag);
      assert.deepEqual(yield* seqs(store, equals("region", "r2")), before.region);

      // Finishing the interrupted seal is just running it again.
      const finished = yield* store.sealPostings;
      assert.ok(finished.segments > 0, "there was sealing left to do");
      assert.deepEqual(yield* seqs(store, term("kind", "post")), before.kind);
      assert.deepEqual(yield* seqs(store, term("tag", "t7")), before.tag);
      assert.deepEqual(yield* seqs(store, equals("region", "r2")), before.region);
    }));
});
