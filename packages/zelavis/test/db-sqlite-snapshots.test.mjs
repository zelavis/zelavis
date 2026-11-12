// A SQLite shard opens at most a bounded number of snapshots at once, each a read-only connection of its own. Past the
// bound a snapshot waits for a place, for a bounded time, and a place is never lost: not to a failure, not to an
// interruption.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Deferred, Effect, Fiber } from "effect";
import { sqliteKvEngineOver } from "../dist/db/engines/sqlite-kv.js";

/** An engine whose read connections are counted while open, and can be told to fail the next one. */
const engineIn = (t, snapshots) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-snapshots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "kv.sqlite");
  const readers = { open: 0, peak: 0, failNext: false };
  const openReader = () => {
    if (readers.failNext) {
      readers.failNext = false;
      throw new Error("injected reader failure");
    }
    const db = new DatabaseSync(file, { readOnly: true });
    readers.open += 1;
    readers.peak = Math.max(readers.peak, readers.open);
    return {
      prepare: (sql) => db.prepare(sql),
      exec: (sql) => db.exec(sql),
      close: () => { readers.open -= 1; db.close(); },
    };
  };
  const engine = sqliteKvEngineOver(new DatabaseSync(file), { openReader, snapshots });
  t.after(() => Effect.runPromise(engine.close));
  return { engine, readers };
};

/** A snapshot held open until `release` completes. */
const hold = (engine, opened, release) => Effect.scoped(Effect.gen(function* () {
  yield* engine.snapshot;
  yield* Deferred.succeed(opened, undefined);
  yield* Deferred.await(release);
}));

test("past the bound a snapshot waits for one to close, and never opens a connection beyond it", async (t) => {
  const { engine, readers } = engineIn(t, { max: 2, waitMillis: 10_000 });
  await Effect.runPromise(Effect.gen(function* () {
    const release = yield* Deferred.make();
    const held = yield* Effect.forEach([1, 2], () => Effect.gen(function* () {
      const opened = yield* Deferred.make();
      const fiber = yield* Effect.forkChild(hold(engine, opened, release));
      yield* Deferred.await(opened);
      return fiber;
    }));
    let third = false;
    const waiting = yield* Effect.forkChild(Effect.scoped(Effect.andThen(engine.snapshot, Effect.sync(() => { third = true; }))));
    yield* Effect.sleep("100 millis");
    assert.equal(third, false, "the third snapshot waits while two are open");
    assert.equal(readers.peak, 2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(waiting);
    yield* Effect.forEach(held, Fiber.join);
    assert.equal(third, true, "it opens once one closes");
    assert.ok(readers.peak <= 2, `${readers.peak} read connections were open at once, past the bound of 2`);
  }));
});

test("a snapshot that waits past its time is refused, with the reason", async (t) => {
  const { engine } = engineIn(t, { max: 1, waitMillis: 50 });
  await Effect.runPromise(Effect.gen(function* () {
    const opened = yield* Deferred.make();
    const release = yield* Deferred.make();
    const holder = yield* Effect.forkChild(hold(engine, opened, release));
    yield* Deferred.await(opened);
    const refused = yield* Effect.flip(Effect.scoped(engine.snapshot));
    assert.equal(refused._tag, "StoreError");
    assert.match(String(refused.cause), /stayed open for .*refused rather than left waiting/);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    // The place is free again.
    yield* Effect.scoped(engine.snapshot);
  }));
});

test("a connection that fails to open gives its place back", async (t) => {
  // A fresh engine has no idle connection to reuse, so this snapshot opens one, and that open fails.
  const { engine, readers } = engineIn(t, { max: 1, waitMillis: 200 });
  await Effect.runPromise(Effect.gen(function* () {
    readers.failNext = true;
    const failed = yield* Effect.flip(Effect.scoped(engine.snapshot));
    assert.equal(failed._tag, "StoreError");
    assert.match(String(failed.cause), /injected reader failure/);
    // The only place is free: a snapshot opens at once, well inside the 200 ms it would otherwise wait.
    yield* Effect.scoped(engine.snapshot);
  }));
});

test("an interrupted wait does not lose a place", async (t) => {
  const { engine } = engineIn(t, { max: 2, waitMillis: 10_000 });
  await Effect.runPromise(Effect.gen(function* () {
    // An interrupted wait.
    const release = yield* Deferred.make();
    const held = yield* Effect.forEach([1, 2], () => Effect.gen(function* () {
      const opened = yield* Deferred.make();
      const fiber = yield* Effect.forkChild(hold(engine, opened, release));
      yield* Deferred.await(opened);
      return fiber;
    }));
    const waiting = yield* Effect.forkChild(Effect.scoped(engine.snapshot));
    yield* Effect.sleep("20 millis");
    yield* Fiber.interrupt(waiting);
    yield* Deferred.succeed(release, undefined);
    yield* Effect.forEach(held, Fiber.join);
    // Both places are still there: two snapshots open together, without waiting.
    const both = yield* Deferred.make();
    const opened = yield* Effect.forEach([1, 2], () => Deferred.make());
    const fibers = yield* Effect.forEach(opened, (signal) => Effect.forkChild(hold(engine, signal, both)));
    yield* Effect.forEach(opened, (signal) => Deferred.await(signal).pipe(Effect.timeout("2 seconds")));
    yield* Deferred.succeed(both, undefined);
    yield* Effect.forEach(fibers, Fiber.join);
  }));
});

test("the bound must be a positive whole number", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-snapshots-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "kv.sqlite");
  const db = new DatabaseSync(file);
  try {
    assert.throws(() => sqliteKvEngineOver(db, { openReader: () => new DatabaseSync(file, { readOnly: true }), snapshots: { max: 0, waitMillis: 10 } }), /not a number of snapshots/);
  } finally { db.close(); }
});
