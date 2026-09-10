// RocksDB through `@harperfast/rocksdb-js`: what this engine must hold to
// beyond the key-value contract every engine passes (db-kv-engines.test.mjs).
//
// The binding is the part being trusted here, so each test pins one thing it
// could get wrong without the shared contract noticing: re-encoded bytes, a
// database two processes both write, a directory opened as the wrong format,
// and corruption read back as data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { and, asSeq, equals, term } from "../dist/db/index.js";
import { columnKey, compareKeys, eventKey, payloadKey, termKey } from "../dist/db/keys.js";
import { FORMAT_FILE, makeRocksdbJsEngine, makeRocksdbJsStore } from "../dist/db/engines/rocksdb-js.js";
import { engineAvailable } from "./_engine-available.mjs";

const skip = engineAvailable("@harperfast/rocksdb-js") ? false : "@harperfast/rocksdb-js is not installed";
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER = new URL("../dist/db/engines/rocksdb-js.js", import.meta.url).href;
const enc = new TextEncoder();
const EMPTY = new Uint8Array(0);

const tempDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `zv-rocksdb-js-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const withEngine = (dir, body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    return yield* body(yield* makeRocksdbJsEngine("kv", dir));
  })));

/** The error an open fails with, or a test failure if it opened. */
const openFailure = async (dir) => {
  const result = await Effect.runPromise(Effect.scoped(Effect.result(makeRocksdbJsEngine("kv", dir))));
  assert.equal(result._tag, "Failure", "the engine opened a directory it should have refused");
  return result.failure;
};

const collect = (stream) => Effect.map(Stream.runCollect(stream), (chunk) => [...chunk]);
const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Writes entries through the engine, then flushes them out of the log into a table file. */
const writeFlushed = async (dir, writes) => {
  await withEngine(dir, (engine) => engine.write(writes));
  const { RocksDatabase } = await import("@harperfast/rocksdb-js");
  const db = new RocksDatabase(join(dir, "kv"), { keyEncoding: "binary", encoding: "binary" });
  db.open();
  db.flushSync();
  db.close();
};

test("rocksdb-js: the key shapes the store writes survive byte for byte, in its order", { skip }, async (t) => {
  // Every shape keys.ts produces that an encoding layer could mangle: terms
  // holding the two bytes the key encoding escapes, one term a prefix of
  // another, bytes above 0x7f, the highest identifier, and the empty value a
  // posting is.
  const cases = [
    termKey("title", "atlas", 1),
    termKey("title", "a\u0000b", 2),
    termKey("title", "a\u0001b", 3),
    termKey("title", "a", 4),
    termKey("title", "ab", 5),
    columnKey("region", "ÿþ", 6),
    payloadKey(0xfffffffe),
    eventKey(1),
    eventKey(256),
  ].map((key, i) => ({ op: "put", key, value: i % 3 === 0 ? EMPTY : Uint8Array.from([i, 0, 1, 255]) }));

  await withEngine(tempDir(t, "fidelity"), (engine) =>
    Effect.gen(function* () {
      yield* engine.write(cases);

      for (const { key, value } of cases) {
        const back = yield* engine.get(key);
        assert.ok(back !== undefined && same(back, value), `value for ${[...key]} came back as ${back && [...back]}`);
      }

      const scanned = yield* collect(engine.scan(EMPTY));
      const expected = cases.map(({ key }) => key).sort(compareKeys);
      assert.equal(scanned.length, expected.length);
      scanned.forEach(({ key }, i) => assert.ok(same(key, expected[i]), `position ${i} is out of order`));

      // The prefix of "a" must not reach "ab" or either escaped term, which
      // share its first letter and continue past it.
      const a = termKey("title", "a", 4);
      const under = yield* collect(engine.scan(a.subarray(0, a.length - 4)));
      assert.deepEqual(under.map(({ key }) => [...key]), [[...a]]);
    }));
});

test("rocksdb-js: a store answers through its lenses, and again after reopening", { skip }, async (t) => {
  const dir = tempDir(t, "store");
  const run = (body) =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      return yield* body(yield* makeRocksdbJsStore("acme", dir));
    })));
  const query = and(term("tag", "t1"), equals("region", "r2"));
  const expected = Array.from({ length: 300 }, (_, i) => i + 1).filter((seq) => seq % 5 === 1 && seq % 3 === 2);

  const first = await run((store) => Effect.gen(function* () {
    for (let seq = 1; seq <= 300; seq++) {
      yield* store.transact((txn) => txn.put(asSeq(seq), enc.encode(`{"seq":${seq}}`), {
        terms: [["tag", `t${seq % 5}`]], columns: [["region", `r${seq % 3}`]], measures: [["visits", seq]], edges: [],
      }));
    }
    return (yield* collect(store.resolve(query))).map(Number);
  }));
  assert.deepEqual(first, expected);

  const reopened = await run((store) => Effect.map(collect(store.resolve(query)), (seqs) => seqs.map(Number)));
  assert.deepEqual(reopened, expected);
});

test("rocksdb-js: a scan the consumer stops early releases the database", { skip }, async (t) => {
  const dir = tempDir(t, "early-stop");
  const writes = Array.from({ length: 5000 }, (_, i) =>
    ({ op: "put", key: enc.encode(`k${String(i).padStart(5, "0")}`), value: EMPTY }));
  const taken = await withEngine(dir, (engine) =>
    Effect.gen(function* () {
      yield* engine.write(writes);
      return yield* collect(Stream.take(engine.scan(EMPTY), 10));
    }));
  assert.equal(taken.length, 10);
  // Released means closable: a native iterator left open would keep the handle,
  // and with it the lock, from going away.
  const reopened = await withEngine(dir, (engine) => collect(engine.scan(EMPTY)));
  assert.equal(reopened.length, 5000);
});

test("rocksdb-js: another process cannot open a directory this one holds", { skip }, async (t) => {
  const dir = tempDir(t, "lock");
  await withEngine(dir, (engine) =>
    Effect.gen(function* () {
      yield* engine.write([{ op: "put", key: enc.encode("held"), value: EMPTY }]);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        const { Effect } = await import("effect");
        const { makeRocksdbJsEngine } = await import(${JSON.stringify(ADAPTER)});
        const result = await Effect.runPromise(Effect.scoped(Effect.result(makeRocksdbJsEngine("kv", ${JSON.stringify(dir)}))));
        console.log(JSON.stringify(result._tag === "Failure"
          ? { opened: false, op: result.failure.op, message: String(result.failure.cause?.message) }
          : { opened: true }));
      `], { cwd: PACKAGE, encoding: "utf8", timeout: 60_000 });
      const report = JSON.parse(child.stdout.trim().split("\n").at(-1));
      assert.equal(report.opened, false, "a second process opened a directory another process was writing");
      assert.equal(report.op, "rocksdb-js.open");
      assert.match(report.message, /lock/i);
    }));
});

test("rocksdb-js: a clean close leaves nothing a reopen can miss", { skip }, async (t) => {
  const dir = tempDir(t, "reopen");
  const writes = Array.from({ length: 2000 }, (_, i) =>
    ({ op: "put", key: enc.encode(`k${String(i).padStart(5, "0")}`), value: enc.encode(`v${i}`) }));
  await withEngine(dir, (engine) => engine.write(writes));
  await withEngine(dir, (engine) =>
    Effect.gen(function* () {
      const back = yield* collect(engine.scan(EMPTY));
      assert.equal(back.length, writes.length);
      assert.deepEqual([...(yield* engine.get(enc.encode("k01999")))], [...enc.encode("v1999")]);
    }));
});

test("rocksdb-js: a directory records its format, and one that says otherwise is refused", { skip }, async (t) => {
  const dir = tempDir(t, "format");
  await withEngine(dir, (engine) => engine.write([{ op: "put", key: enc.encode("k"), value: EMPTY }]));
  const markerPath = join(dir, "kv", FORMAT_FILE);
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.equal(marker.engine, "rocksdb-js");
  assert.equal(marker.format, 1);
  assert.equal(marker.keyEncoding, "binary");
  assert.equal(marker.encoding, "binary");
  assert.match(marker.createdWith.rocksdb, /^\d+\.\d+\.\d+$/);

  // Reopening a directory this engine wrote is ordinary.
  await withEngine(dir, (engine) => engine.get(enc.encode("k")));

  writeFileSync(markerPath, JSON.stringify({ ...marker, keyEncoding: "ordered-binary" }));
  assert.match(String((await openFailure(dir)).cause?.message), /was written as/);

  writeFileSync(markerPath, "{ not json");
  assert.equal((await openFailure(dir)).op, "rocksdb-js.open");

  // No marker at all: some RocksDB directory, written by who knows what. It is
  // refused before RocksDB touches it, so refusing costs the directory nothing.
  unlinkSync(markerPath);
  const before = readdirSync(join(dir, "kv")).sort();
  assert.match(String((await openFailure(dir)).cause?.message), new RegExp(`no ${FORMAT_FILE}`));
  assert.deepEqual(readdirSync(join(dir, "kv")).sort(), before, "a refused open changed the directory");
});

test("rocksdb-js: a database whose manifest pointer is corrupt fails to open", { skip }, async (t) => {
  const dir = tempDir(t, "corrupt-current");
  await withEngine(dir, (engine) => engine.write([{ op: "put", key: enc.encode("k"), value: EMPTY }]));
  writeFileSync(join(dir, "kv", "CURRENT"), "MANIFEST-999999\n");
  assert.equal((await openFailure(dir)).op, "rocksdb-js.open");
});

/** A directory whose one table file has a damaged first data block. */
const corruptedTable = async (t) => {
  const dir = tempDir(t, "corrupt-sst");
  const writes = Array.from({ length: 20_000 }, (_, i) =>
    ({ op: "put", key: enc.encode(`k${String(i).padStart(6, "0")}`), value: new Uint8Array(40).fill(i & 0xff) }));
  await writeFlushed(dir, writes);
  const tables = readdirSync(join(dir, "kv")).filter((name) => name.endsWith(".sst"));
  assert.equal(tables.length, 1, "the flush left one table file to damage");
  const path = join(dir, "kv", tables[0]);
  const bytes = readFileSync(path);
  assert.ok(statSync(path).size > 4096);
  for (let i = 64; i < 192; i++) bytes[i] ^= 0xff;
  writeFileSync(path, bytes);
  return { dir, first: writes[0].key, total: writes.length };
};

test("rocksdb-js: a point read of a corrupted block fails rather than answering", { skip }, async (t) => {
  const { dir, first } = await corruptedTable(t);
  const result = await withEngine(dir, (engine) => Effect.result(engine.get(first)));
  assert.equal(result._tag, "Failure", "a checksum mismatch was read as data");
  assert.equal(result.failure.op, "rocksdb-js.get");
  assert.match(String(result.failure.cause?.message), /Corruption/);
});

test("rocksdb-js: a scan over a corrupted block fails rather than ending early", {
  skip,
  // The binding sees the iterator's failed status and returns "done" instead:
  // src/binding/iterator/db_iterator.cpp, DBIterator::Next. Nothing reaches
  // JavaScript, so this adapter cannot report it either. The discontinued
  // binding threw. This test passing is a condition for switching engines.
  // Reported as HarperFast/rocksdb-js#846.
  todo: "@harperfast/rocksdb-js ends a scan quietly when RocksDB's iterator fails",
}, async (t) => {
  const { dir, total } = await corruptedTable(t);
  const result = await withEngine(dir, (engine) => Effect.result(collect(engine.scan(EMPTY))));
  assert.equal(result._tag, "Failure",
    `the scan returned ${result.success?.length} of ${total} entries and no error`);
});
