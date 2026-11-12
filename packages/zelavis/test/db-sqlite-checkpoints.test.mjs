// Under Node, a SQLite shard's write-ahead log is folded back into its file by a checkpoint thread, not inside a
// commit on the main thread. SQLite's own checkpoint stays on as a backstop at a higher threshold.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { sqliteKvEngineOver } from "../dist/db/engines/sqlite-kv.js";

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-checkpoints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));
const sizeOf = (file) => existsSync(file) ? statSync(file).size : 0;

/** About `megabytes` of distinct values, in batches, the way bulk ingest writes them. */
const fill = (engine, megabytes) => Effect.forEach(Array.from({ length: megabytes * 16 }, (_, batch) => batch), (batch) =>
  engine.write(Array.from({ length: 16 }, (_, at) => ({
    op: "put",
    key: new TextEncoder().encode(`k${String(batch * 16 + at).padStart(8, "0")}`),
    value: new Uint8Array(4096).fill((batch + at) % 251),
  }))), { discard: true });

test("the log is folded into the file by the checkpoint thread, well below the commit path's own threshold", async (t) => {
  const dir = temp(t);
  const file = join(dir, "s0.sqlite");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine("s0", dir);
    // 8 MiB: half the 16 MiB at which SQLite would checkpoint inside a commit, so a database file that grows
    // to hold it was filled by the checkpoint thread.
    yield* fill(engine, 8);
    const filled = Date.now();
    while (sizeOf(file) < 8 * 1024 * 1024) {
      assert.ok(Date.now() - filled < 10_000, `the database file holds ${sizeOf(file)} bytes; the log was never folded into it`);
      yield* Effect.promise(() => wait(25));
    }
    // Every value is still there, read back through the engine.
    const last = yield* engine.get(new TextEncoder().encode(`k${String(8 * 16 * 16 - 1).padStart(8, "0")}`));
    assert.equal(last?.length, 4096);
  })));
  // Closed: neither the engine nor the checkpoint thread holds the file any more, so it can be removed.
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(file), false);
});

test("negative control: without the checkpoint thread the same writes stay in the log", async (t) => {
  const dir = temp(t);
  const file = join(dir, "c.sqlite");
  const db = new DatabaseSync(file);
  const engine = sqliteKvEngineOver(db, { openReader: () => new DatabaseSync(file, { readOnly: true }) });
  try {
    await Effect.runPromise(fill(engine, 8));
    await wait(500);
    assert.ok(sizeOf(file) < 1024 * 1024, `the database file holds ${sizeOf(file)} bytes; only a checkpoint could have put them there`);
    assert.ok(sizeOf(`${file}-wal`) > 8 * 1024 * 1024, "the writes are in the log");
  } finally { await Effect.runPromise(engine.close); }
});

test("the commit path keeps a backstop: raised with a checkpoint thread, SQLite's own threshold without one", (t) => {
  const dir = temp(t);
  const pragmas = (checkpoints) => {
    const file = join(dir, `p-${checkpoints ?? "default"}.sqlite`);
    const db = new DatabaseSync(file);
    try {
      sqliteKvEngineOver(db, { openReader: () => new DatabaseSync(file, { readOnly: true }), ...(checkpoints ? { checkpoints } : {}) });
      return {
        autocheckpoint: db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint,
        journalSizeLimit: db.prepare("PRAGMA journal_size_limit").get().journal_size_limit,
      };
    } finally { db.close(); }
  };
  assert.deepEqual(pragmas(undefined), { autocheckpoint: 4000, journalSizeLimit: -1 }, "SQLite checkpoints inside commits by default");
  assert.deepEqual(pragmas("engine"), { autocheckpoint: 4000, journalSizeLimit: -1 });
  // Never trimmed: a reset log is written again over space it already has, where a trimmed one would grow back.
  assert.deepEqual(pragmas("background"), { autocheckpoint: 16000, journalSizeLimit: -1 }, "a stalled checkpoint thread still leaves the log bounded");
});

test("several shards checkpoint at once, and once closed nothing holds any of them, round after round", async (t) => {
  const dir = temp(t);
  await Effect.runPromise(Effect.gen(function* () {
    for (const round of [1, 2]) {
      yield* Effect.scoped(Effect.gen(function* () {
        const engines = yield* Effect.forEach(["a", "b", "c"], (name) => makeNodeSqliteEngine(`${name}${round}`, dir));
        yield* Effect.forEach(engines, (engine) => fill(engine, 1), { concurrency: "unbounded", discard: true });
      }));
      for (const name of ["a", "b", "c"]) {
        const file = join(dir, `${name}${round}.sqlite`);
        // Closing the last connection to a file checkpoints it and removes its log: nothing was left open.
        assert.equal(existsSync(`${file}-wal`), false, `${name}${round}: every connection to it is closed`);
        rmSync(file);
      }
    }
  }));
});

test("the checkpoint thread never creates a file: a shard's files removed from under it stay removed", async (t) => {
  const dir = temp(t);
  const file = join(dir, "gone.sqlite");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine("gone", dir);
    yield* fill(engine, 1);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    // Several ticks of the checkpoint thread.
    yield* Effect.promise(() => wait(400));
    for (const suffix of ["", "-wal", "-shm"]) assert.equal(existsSync(`${file}${suffix}`), false, `${file}${suffix} came back`);
  })));
});

test("the checkpoint thread starts in a process run with flags a worker file refuses", async (t) => {
  const dir = temp(t);
  const code = `import { existsSync, statSync } from "node:fs";
    import { Effect } from "effect";
    import { makeNodeSqliteEngine } from "./dist/db/engines/node-sqlite.js";
    const dir = process.argv[1];
    const file = dir + "/flags.sqlite";
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const engine = yield* makeNodeSqliteEngine("flags", dir);
      yield* Effect.forEach(Array.from({ length: 64 }, (_, batch) => batch), (batch) => engine.write(Array.from({ length: 16 }, (_, at) => ({
        op: "put", key: new TextEncoder().encode("k" + (batch * 16 + at)), value: new Uint8Array(4096).fill(1),
      }))), { discard: true });
      const started = Date.now();
      while (statSync(file).size < 4 * 1024 * 1024 && Date.now() - started < 10000) yield* Effect.sleep("25 millis");
      console.log(JSON.stringify({ folded: statSync(file).size >= 4 * 1024 * 1024 }));
    })));`;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, dir], { cwd: new URL("..", import.meta.url) });
  // Nothing but its own answer: a thread that failed to start would have warned on this stream.
  assert.deepEqual(JSON.parse(child.stdout), { folded: true });
});

// The checkpoint thread's own connection takes the shard's durability (`synchronous`, `fullfsync`); that connection is
// private to the thread, so this checks that a power shard runs with it, not the pragmas it holds.
test("a power shard writes and is checkpointed in the background", async (t) => {
  const dir = temp(t);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = yield* makeNodeSqliteEngine("p", dir, "power");
    yield* fill(engine, 1);
    assert.equal((yield* engine.get(new TextEncoder().encode("k00000000")))?.length, 4096);
  })));
});
