// Concurrent writers to one store each land, on every engine.
//
// A commit reads the log's next position and writes it back advanced, and
// `nextSeq` does the same with the identifier counter. On an engine whose reads
// and writes are asynchronous, two of those in flight at once read the same
// value, and the second write replaces the first: a transaction that returned
// successfully and left no trace, or one identifier handed to two objects.
// SQLite hid this by being synchronous. LMDB and RocksDB each lost 31 of 32
// concurrent commits without an error. The store serializes its writers so
// that cannot happen.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { term } from "../dist/db/index.js";
import { engineAvailable } from "./_engine-available.mjs";

const enc = new TextEncoder();
const COUNT = 64;

const engines = [
  ["sqlite", true,
    async (dir) => (await import("../dist/db/engines/node-sqlite.js")).makeNodeSqliteStore("acme", dir)],
  ["libsql", engineAvailable("libsql"),
    async (dir) => (await import("../dist/db/engines/libsql.js")).makeLibsqlStore("acme", { directory: dir })],
  ["lmdb", engineAvailable("lmdb"),
    async (dir) => (await import("../dist/db/engines/lmdb.js")).makeLmdbStore("acme", dir)],
  ["rocksdb", engineAvailable("rocksdb"),
    async (dir) => (await import("../dist/db/engines/rocksdb.js")).makeRocksdbStore("acme", dir)],
];

for (const [engine, available, open] of engines) {
  test(`${engine}: concurrent writers each land`,
    { skip: available ? false : `${engine} is not installed` },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), `zv-concurrent-${engine}-`));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const make = await open(dir);

      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const store = yield* make;

        const seqs = (yield* Effect.all(
          Array.from({ length: COUNT }, () => store.nextSeq),
          { concurrency: "unbounded" },
        )).map(Number);
        assert.equal(new Set(seqs).size, COUNT, "nextSeq handed one identifier out twice");

        yield* Effect.all(
          seqs.map((seq) => store.transact((txn) =>
            txn.put(seq, enc.encode(`{"seq":${seq}}`),
              { terms: [["kind", "post"]], columns: [], measures: [], edges: [] }))),
          { concurrency: "unbounded", discard: true },
        );

        const logged = [...(yield* Stream.runCollect(store.events.read({ limit: 1_000_000 })))]
          .map((event) => Number(event.seq));
        assert.equal(logged.length, COUNT,
          `${COUNT - logged.length} of ${COUNT} commits returned and are missing from the log`);
        assert.deepEqual(logged.slice().sort((a, b) => a - b), seqs.slice().sort((a, b) => a - b));
        assert.equal([...(yield* Stream.runCollect(store.resolve(term("kind", "post"))))].length, COUNT,
          "a lens lost an object whose commit returned");
      })));
    });
}
