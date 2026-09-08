import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Stream } from "effect";
import { compareKeys, termKey, termPrefix, seqOf } from "../dist/db/keys.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { makeNodeSqliteEngine } from "../dist/db/engines/node-sqlite.js";
import { makeRocksdbEngine } from "../dist/db/engines/rocksdb.js";
import { makeLmdbEngine } from "../dist/db/engines/lmdb.js";

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const key = (...parts) => Uint8Array.from(parts);

// Every engine runs the same suite. A driver that disagrees with another here
// disagrees with the store, which is the whole point of having an interface.
const engines = [
  ["memory", () => Effect.succeed(memoryKvEngine())],
  ["sqlite", (dir) => makeNodeSqliteEngine("kv", dir)],
  ["rocksdb", (dir) => makeRocksdbEngine("kv", dir)],
  ["lmdb", (dir) => makeLmdbEngine("kv", dir)],
];

const run = (t, make, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-kv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const engine = yield* make(dir);
      return yield* body(engine);
    })),
  );
};

const collect = (engine, prefix) =>
  Effect.map(Stream.runCollect(engine.scan(prefix)), (c) => [...c]);

for (const [name, make] of engines) {
  test(`${name}: get returns what was written, and nothing else`, async (t) => {
    await run(t, make, (engine) =>
      Effect.gen(function* () {
        yield* engine.write([{ op: "put", key: key(1, 2), value: bytes("hello") }]);
        assert.equal(text(yield* engine.get(key(1, 2))), "hello");
        assert.equal(yield* engine.get(key(1, 3)), undefined, "a missing key is undefined");

        yield* engine.write([{ op: "put", key: key(1, 2), value: bytes("replaced") }]);
        assert.equal(text(yield* engine.get(key(1, 2))), "replaced", "put overwrites");

        yield* engine.write([{ op: "delete", key: key(1, 2) }]);
        assert.equal(yield* engine.get(key(1, 2)), undefined);
        yield* engine.write([{ op: "delete", key: key(9, 9) }]);
      }),
    );
  });

  test(`${name}: scans return a prefix range in ascending key order`, async (t) => {
    await run(t, make, (engine) =>
      Effect.gen(function* () {
        // Written out of order on purpose; the engine owns the ordering.
        const ids = [10, 2, 300, 1, 65536];
        yield* engine.write(
          ids.map((n) => ({ op: "put", key: termKey("title", "atlas", n), value: bytes(`v${n}`) })),
        );
        // Neighbours that must not appear: same field other term, other field,
        // and a term this one is a text prefix of.
        yield* engine.write([
          { op: "put", key: termKey("title", "beacon", 1), value: bytes("no") },
          { op: "put", key: termKey("body", "atlas", 1), value: bytes("no") },
          { op: "put", key: termKey("title", "atlantic", 1), value: bytes("no") },
        ]);

        const found = yield* collect(engine, termPrefix("title", "atlas"));
        assert.deepEqual(found.map((e) => seqOf(e.key)), [1, 2, 10, 300, 65536],
          "sorted numerically, and only this field and term");
        assert.deepEqual(found.map((e) => text(e.value)), ["v1", "v2", "v10", "v300", "v65536"]);

        assert.deepEqual(yield* collect(engine, termPrefix("title", "absent")), [],
          "an empty range is empty, not everything");
      }),
    );
  });

  test(`${name}: a batch lands whole, and later writes see earlier ones`, async (t) => {
    await run(t, make, (engine) =>
      Effect.gen(function* () {
        yield* engine.write([
          { op: "put", key: key(1), value: bytes("a") },
          { op: "put", key: key(2), value: bytes("b") },
          { op: "put", key: key(3), value: bytes("c") },
        ]);
        assert.equal(text(yield* engine.get(key(2))), "b");

        // A batch that writes then deletes the same key ends deleted: order
        // within a batch is the order given.
        yield* engine.write([
          { op: "put", key: key(4), value: bytes("d") },
          { op: "delete", key: key(1) },
          { op: "delete", key: key(4) },
        ]);
        assert.equal(yield* engine.get(key(1)), undefined);
        assert.equal(yield* engine.get(key(4)), undefined);
        assert.equal(text(yield* engine.get(key(3))), "c", "untouched keys survive");
      }),
    );
  });

  test(`${name}: binary values survive unchanged`, async (t) => {
    await run(t, make, (engine) =>
      Effect.gen(function* () {
        // Payloads are arbitrary bytes, including the ones the key encoding
        // treats specially. A value is never parsed, so nothing may escape it.
        const payload = Uint8Array.from([0, 1, 2, 255, 0, 0, 254, 127]);
        yield* engine.write([{ op: "put", key: key(7), value: payload }]);
        assert.deepEqual([...(yield* engine.get(key(7)))], [...payload]);

        const empty = new Uint8Array(0);
        yield* engine.write([{ op: "put", key: key(8), value: empty }]);
        assert.deepEqual([...(yield* engine.get(key(8)))], []);
      }),
    );
  });

  test(`${name}: keys order bytewise, including shared prefixes`, async (t) => {
    await run(t, make, (engine) =>
      Effect.gen(function* () {
        const keys = [key(1), key(1, 0), key(1, 255), key(2), key(1, 0, 0)];
        yield* engine.write(keys.map((k) => ({ op: "put", key: k, value: bytes("x") })));
        const found = yield* collect(engine, Uint8Array.from([]));
        const order = found.map((e) => [...e.key]);
        const expected = [...keys].sort(compareKeys).map((k) => [...k]);
        assert.deepEqual(order, expected, "a shorter key sorts before its extensions");
      }),
    );
  });
}
