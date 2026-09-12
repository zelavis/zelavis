// The remote libSQL engine, against a real database.
//
// Every other engine is held to `db-kv-engines`; this one cannot be, because
// it needs a server to talk to. So it runs the same contract — ordering,
// bounds, limits, atomic batches, binary round-trips — against whatever
// database TURSO_URL names, and skips when there is none. A driver nobody has
// pointed at a server is a driver nobody can vouch for.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { compareKeys } from "../dist/db/keys.js";
import { makeLibsqlRemoteEngine } from "../dist/db/engines/libsql-remote.js";

const url = process.env.TURSO_URL;
const authToken = process.env.TURSO_TOKEN;
const skip = url === undefined || authToken === undefined
  ? "set TURSO_URL and TURSO_TOKEN to run the remote libSQL contract"
  : false;

const key = (...parts) => Uint8Array.from(parts);
const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

// A partition of its own per run, so a failed run never poisons the next.
const partition = `zvtest_${Date.now().toString(36)}`;

const withEngine = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const engine = yield* makeLibsqlRemoteEngine(partition, { url, authToken });
    try {
      return yield* body(engine);
    } finally {
      // Leave nothing behind in someone's real database.
      yield* Effect.orDie(engine.write(
        [...(yield* Stream.runCollect(engine.scan(new Uint8Array(0))))]
          .map((entry) => ({ op: "delete", key: entry.key })),
      ));
    }
  })));

const keysOf = (stream) => Effect.map(Stream.runCollect(stream), (c) => [...c].map((e) => [...e.key]));

test("libsql-remote: the key-value contract holds over the network", { skip }, async () => {
  await withEngine((engine) =>
    Effect.gen(function* () {
      const inside = [1, 2, 3, 4, 5].map((n) => key(9, n));
      yield* engine.write([
        ...inside.map((k) => ({ op: "put", key: k, value: k })),
        { op: "put", key: key(8, 9), value: bytes("neighbour") },
        { op: "put", key: key(10), value: bytes("neighbour") },
      ]);

      assert.deepEqual(text(yield* engine.get(key(8, 9))), "neighbour");
      assert.equal(yield* engine.get(key(7)), undefined);

      const scan = (options) => keysOf(engine.scan(key(9), options));
      const ascending = inside.map((k) => [...k]);
      assert.deepEqual(yield* scan(), ascending, "a prefix scan is its own range, in order");
      assert.deepEqual(yield* scan({ reverse: true }), [...ascending].reverse());
      assert.deepEqual(yield* scan({ from: key(9, 2), to: key(9, 4) }), [[9, 2], [9, 3]]);
      assert.deepEqual(yield* scan({ from: key(9, 2), to: key(9, 4), reverse: true }), [[9, 3], [9, 2]]);
      assert.deepEqual(yield* scan({ from: key(8), to: key(11) }), ascending, "bounds are clipped to the prefix");
      assert.deepEqual(yield* scan({ from: key(9, 3), to: key(9, 3) }), []);
      // The limit reaches the statement, so a page costs the rows it returns.
      assert.deepEqual(yield* scan({ limit: 2 }), [[9, 1], [9, 2]]);
      assert.deepEqual(yield* scan({ reverse: true, limit: 2 }), [[9, 5], [9, 4]]);
      assert.deepEqual(yield* scan({ limit: 0 }), []);

      // A later write in one batch sees the earlier one, and a put replaces.
      yield* engine.write([
        { op: "put", key: key(9, 1), value: bytes("first") },
        { op: "put", key: key(9, 1), value: bytes("second") },
        { op: "delete", key: key(9, 5) },
      ]);
      assert.equal(text(yield* engine.get(key(9, 1))), "second");
      assert.equal(yield* engine.get(key(9, 5)), undefined);

      // Binary values survive unchanged, including bytes a text codec would ruin.
      const awkward = Uint8Array.from([0, 1, 0xff, 0xfe, 0x80, 0]);
      yield* engine.write([{ op: "put", key: key(9, 6), value: awkward }]);
      assert.deepEqual([...(yield* engine.get(key(9, 6)))], [...awkward]);

      // Keys order bytewise, which every posting scan depends on.
      const sorted = [...(yield* Stream.runCollect(engine.scan(new Uint8Array(0))))].map((e) => e.key);
      for (let i = 1; i < sorted.length; i++) {
        assert.ok(compareKeys(sorted[i - 1], sorted[i]) < 0, "keys come back in byte order");
      }
    }));
});

test("libsql-remote: a batch that fails lands nothing", { skip }, async () => {
  await withEngine((engine) =>
    Effect.gen(function* () {
      yield* engine.write([{ op: "put", key: key(1), value: bytes("one") }]);
      // A batch is the whole transaction mechanism: one bad statement in it
      // must leave the others unwritten, or every guarantee above this breaks.
      const outcome = yield* Effect.exit(engine.write([
        { op: "put", key: key(2), value: bytes("two") },
        { op: "put", key: key(3), value: undefined },
      ]));
      assert.equal(outcome._tag, "Failure");
      assert.equal(yield* engine.get(key(2)), undefined, "the first statement went back with the second");
      assert.equal(text(yield* engine.get(key(1))), "one", "and what was already there is untouched");
    }));
});
