// Partitions: one shard, many partitions, each owning a range of its keys.
//
// A partition has its own identifiers, its own log and its own writer, so what
// these pin is that nothing leaks between them, that events replayed into a
// partition late, twice or out of order cannot bring back what was removed, and
// that a follower keeps its leader's history rather than only its state.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Stream } from "effect";
import { documentsFor, inPrefixRange, MAX_SEQ, partitionKeys, Tag, term, u64Bytes } from "../dist/db/index.js";
import { makeMemoryStore, memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { StoreError } from "../dist/db/errors.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const manifest = (words) => ({ terms: words.map((w) => ["title", w]), columns: [["kind", "post"]], measures: [], edges: [] });
const put = (store, seq, words, body = "x") =>
  store.transact((txn) => txn.put(seq, enc.encode(body), manifest(words), { namespace: "doc/x", key: `k${seq}` }));
const retract = (store, seq) => store.transact((txn) => txn.retract(seq));
const events = (store, options) => Effect.map(Stream.runCollect(store.events.read(options)), (c) => [...c]);
const seqs = (store, query) => Effect.map(Stream.runCollect(store.resolve(query)), (c) => [...c].map(Number));
const applied = ({ cursor, ...event }) => event;
const partitionOf = (engine, name) => Effect.map(openShardOverKv("s", engine), (shard) => shard.partition(name));

const rnd = (seed) => () =>
  ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 0) / 0x80000000;

test("an event applied again after its record was retracted brings nothing back", () => run(Effect.gen(function* () {
  const leader = (yield* makeMemoryStore("one")).partition("acme");
  const seq = yield* leader.nextSeq;
  yield* put(leader, seq, ["atlas"]);
  yield* retract(leader, seq);
  const log = yield* events(leader);

  const follower = (yield* makeMemoryStore("two")).partition("acme");
  for (const event of log) yield* follower.events.apply(applied(event));
  assert.equal(yield* follower.read(seq), undefined);

  // A late or repeated delivery of the put finds the retraction's newer
  // version and changes nothing.
  yield* follower.events.apply(applied(log[0]));
  assert.equal(yield* follower.read(seq), undefined, "the old put brought the record back");
  assert.deepEqual(yield* seqs(follower, term("title", "atlas")), []);
  assert.equal((yield* follower.stats).records, 0);

  // So does a retraction delivered before the put it follows.
  const reordered = (yield* makeMemoryStore("three")).partition("acme");
  yield* reordered.events.apply(applied(log[1]));
  yield* reordered.events.apply(applied(log[0]));
  assert.equal(yield* reordered.read(seq), undefined);
  assert.deepEqual(yield* seqs(reordered, term("title", "atlas")), []);
})));

test("a follower keeps its leader's positions: repeats are checked, gaps and divergence refused", () => run(Effect.gen(function* () {
  const leader = (yield* makeMemoryStore("one")).partition("acme");
  const follower = (yield* makeMemoryStore("two")).partition("acme");
  for (const word of ["atlas", "beacon", "cobalt"]) yield* put(leader, yield* leader.nextSeq, [word]);
  const log = yield* events(leader);
  for (const event of log) yield* follower.events.follow(event);

  // One history in two places: the leader's cursors continue the follower's log.
  assert.deepEqual((yield* events(follower)).map((e) => e.cursor), log.map((e) => e.cursor));
  assert.deepEqual((yield* events(follower, { after: log[0].cursor })).map((e) => Number(e.seq)), [2, 3]);

  // A repeated delivery is compared with what is held and skipped.
  yield* follower.events.follow(log[1]);
  assert.equal((yield* follower.stats).head, 3);

  // An event past the next position would leave a hole.
  yield* put(leader, yield* leader.nextSeq, ["delta"]);
  yield* put(leader, yield* leader.nextSeq, ["ember"]);
  const more = yield* events(leader, { after: log[2].cursor });
  const gap = yield* Effect.flip(follower.events.follow(more[1]));
  assert.equal(gap._tag, "EventGap");
  assert.deepEqual([gap.expected, gap.received], [4, 5]);

  // A different event at a position already held is two histories, not a repeat.
  const diverged = yield* Effect.flip(follower.events.follow({ ...log[1], version: 99 }));
  assert.equal(diverged._tag, "ReplicaDiverged");
  assert.equal(diverged.position, 2);

  // And a position in another partition's log names nothing here.
  const other = (yield* makeMemoryStore("three")).partition("globex");
  yield* put(other, yield* other.nextSeq, ["atlas"]);
  const [foreign] = yield* events(other);
  assert.equal((yield* Effect.flip(follower.events.follow(foreign)))._tag, "ForeignCursor");
})));

test("identifiers are refused at the limit rather than wrapped", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const store = yield* partitionOf(engine, "acme");
  assert.equal(Number(yield* store.nextSeq), 1);
  yield* engine.write([{ op: "put", key: partitionKeys("acme").meta("next_seq"), value: u64Bytes(MAX_SEQ - 1) }]);
  assert.equal(Number(yield* store.nextSeq), MAX_SEQ, "the last identifier is still handed out");
  const refused = yield* Effect.flip(store.nextSeq);
  assert.equal(refused._tag, "PartitionExhausted");
  assert.equal(refused.resource, "identifiers");
  assert.equal(refused.limit, MAX_SEQ);
  const inside = yield* Effect.flip(store.transact((txn) => txn.allocate));
  assert.equal(inside.resource, "identifiers", "allocating inside a transaction is refused the same way");
})));

test("a log at its last position refuses the next event rather than wrapping, and writes nothing", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const store = yield* partitionOf(engine, "acme");
  yield* put(store, 1, ["first"]);
  yield* engine.write([{ op: "put", key: partitionKeys("acme").meta("head"), value: u64Bytes(Number.MAX_SAFE_INTEGER) }]);
  const before = yield* store.stats;
  // A failure the caller can see, not a defect: Effect.flip would rethrow one.
  const refused = yield* Effect.flip(put(store, 2, ["second"]));
  assert.equal(refused._tag, "PartitionExhausted");
  assert.equal(refused.resource, "log");
  assert.deepEqual(yield* store.stats, before);
})));

test("partitions on one shard read only their own records, words, names and history", () => run(Effect.gen(function* () {
  const shard = yield* makeMemoryStore("s0");
  const names = ["acme", "acme#part", "globex"];
  const rand = rnd(20261021);
  const live = new Map(names.map((name) => [name, new Set()]));
  const writes = new Map(names.map((name) => [name, 0]));

  for (let i = 0; i < 150; i++) {
    const name = names[Math.floor(rand() * names.length)];
    const store = shard.partition(name);
    const held = [...live.get(name)];
    if (held.length > 0 && rand() < 0.25) {
      const seq = held[Math.floor(rand() * held.length)];
      yield* retract(store, seq);
      live.get(name).delete(seq);
    } else {
      const seq = Number(yield* store.nextSeq);
      yield* put(store, seq, ["shared", `only-${name}`]);
      live.get(name).add(seq);
    }
    writes.set(name, writes.get(name) + 1);
  }

  assert.deepEqual(yield* shard.partitions, names, "each partition is listed once, in key order");
  for (const name of names) {
    const store = shard.partition(name);
    // Identifiers are the partition's own: every partition starts at one, so
    // the same numbers are in use next door, and a leak would show here.
    assert.deepEqual(new Set(yield* seqs(store, term("title", "shared"))), live.get(name), `${name}'s records`);
    assert.deepEqual(yield* store.terms("title"), [`only-${name}`, "shared"].sort(), `${name}'s words`);
    const log = yield* events(store, { limit: 10_000 });
    assert.equal(log.length, writes.get(name), `${name}'s history`);
    assert.ok(log.every((event) => event.partition === name));
    assert.equal((yield* store.stats).records, live.get(name).size);
    for (const other of names.filter((n) => n !== name)) {
      for (const seq of live.get(other)) {
        if (!live.get(name).has(seq)) assert.equal(yield* store.read(seq), undefined, `${other}'s record ${seq} read through ${name}`);
      }
    }
  }
})));

test("dropping a partition removes all of it and nothing of its neighbours", () => run(Effect.gen(function* () {
  const shard = yield* makeMemoryStore("s0");
  const acme = shard.partition("acme");
  const globex = shard.partition("globex");
  for (const word of ["atlas", "beacon"]) yield* put(acme, yield* acme.nextSeq, [word]);
  yield* put(globex, yield* globex.nextSeq, ["cobalt"]);
  yield* acme.sealPostings;

  assert.equal(yield* shard.drop("acme"), 2, "it answers how many records it held");
  assert.deepEqual(yield* shard.partitions, ["globex"]);
  assert.deepEqual(yield* events(acme), []);
  assert.deepEqual(yield* acme.stats, { records: 0, bytes: 0, head: 0, compactedTo: 0, nextSeq: 0, seeding: false });
  assert.deepEqual(yield* seqs(acme, term("title", "atlas")), []);
  assert.deepEqual(yield* seqs(globex, term("title", "cobalt")), [1]);

  // Writable again, from nothing.
  assert.equal(Number(yield* acme.nextSeq), 1);
  yield* put(acme, 1, ["delta"]);
  assert.deepEqual(yield* seqs(acme, term("title", "delta")), [1]);
})));

test("compaction drops a retired record only once its retraction is behind the cut", () => run(Effect.gen(function* () {
  const engine = memoryKvEngine();
  const store = yield* partitionOf(engine, "acme");
  const keys = partitionKeys("acme");
  for (let seq = 1; seq <= 3; seq++) yield* put(store, seq, ["atlas"]);
  yield* retract(store, 1);
  assert.notEqual(yield* engine.get(keys.record(1)), undefined, "a retired record keeps its version");

  yield* retract(store, 2);
  // Keep the last event, which is the second retraction: only the first is behind the cut.
  yield* store.compact({ keep: 1 });
  assert.equal(yield* engine.get(keys.record(1)), undefined, "retired behind the cut, and gone");
  assert.notEqual(yield* engine.get(keys.record(2)), undefined, "retired ahead of the cut, and kept");
  assert.notEqual(yield* engine.get(keys.record(3)), undefined, "a live record is never touched");
  assert.deepEqual(yield* seqs(store, term("title", "atlas")), [3]);
})));

test("an update writes only the postings that changed", () => run(Effect.gen(function* () {
  const base = memoryKvEngine();
  const batches = [];
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) => {
      batches.push(writes);
      return base.conditionalWrite(writes, conditions);
    },
  };
  const store = yield* partitionOf(engine, "acme");
  const keys = partitionKeys("acme");
  const wide = (changed) => ({
    terms: [], measures: [], edges: [],
    columns: Array.from({ length: 50 }, (_, i) => [`f${i}`, i === 7 ? changed : i]),
  });
  yield* store.transact((txn) => txn.put(1, enc.encode("{}"), wide("before")));
  batches.length = 0;
  yield* store.transact((txn) => txn.put(1, enc.encode("{}"), wide("after")));

  assert.equal(batches.length, 1, "one commit, one batch");
  const postings = batches[0].filter((write) => inPrefixRange(write.key, keys.tag(Tag.Ordered)));
  assert.deepEqual(postings.map((write) => write.op).sort(), ["delete", "put"],
    "the one changed column's old posting goes and its new one comes; the other 49 are left alone");
})));

test("a partition counts its records and their bytes as it goes, and a rebuild agrees", () => run(Effect.gen(function* () {
  const store = (yield* makeMemoryStore("s0")).partition("acme");
  yield* put(store, 1, ["atlas"], "12345");
  yield* put(store, 2, ["beacon"], "123");
  yield* put(store, 1, ["atlas"], "1234567");
  yield* retract(store, 2);
  const expected = { records: 1, bytes: 7 };
  const counted = ({ records, bytes }) => ({ records, bytes });
  assert.deepEqual(counted(yield* store.stats), expected);
  yield* store.rebuildLenses;
  assert.deepEqual(counted(yield* store.stats), expected, "a rebuild counts the same");
  yield* store.reindexLenses;
  assert.deepEqual(counted(yield* store.stats), expected);
})));

test("an event says which node accepted it, wherever it is read", () => run(Effect.gen(function* () {
  const leader = (yield* makeMemoryStore("one", { origin: "node-7" })).partition("acme");
  yield* put(leader, 1, ["atlas"]);
  const [event] = yield* events(leader);
  assert.equal(event.origin, "node-7");

  const follower = (yield* makeMemoryStore("two", { origin: "node-9" })).partition("acme");
  yield* follower.events.apply(applied(event));
  yield* put(follower, 2, ["beacon"]);
  assert.deepEqual((yield* events(follower)).map((e) => e.origin), ["node-7", "node-9"],
    "a copied event keeps its writer; a local one names this node");
})));

test("a seed taken while the source is written ends, once the log is followed, as an exact copy", () => run(Effect.gen(function* () {
  const source = (yield* makeMemoryStore("one")).partition("acme");
  for (let seq = 1; seq <= 6; seq++) yield* put(source, seq, ["atlas", `w${seq}`], `v1-${seq}`);
  yield* retract(source, 2);
  yield* source.compact({ keep: 3 });

  // The records are read while the source carries on: everything up to record
  // 3 as it was, everything after as later writes left it.
  const racing = {
    ...source,
    records: Stream.unwrap(Effect.gen(function* () {
      const before = [...(yield* Stream.runCollect(source.records))];
      yield* put(source, 4, ["beacon"], "v2-4");
      yield* retract(source, 5);
      yield* put(source, 3, ["cobalt"], "v2-3");
      yield* put(source, 7, ["delta"], "v1-7");
      const after = [...(yield* Stream.runCollect(source.records))];
      const cut = before.findIndex((entry) => Number(entry.seq) === 3);
      return Stream.fromIterable([...before.slice(0, cut + 1), ...after.slice(cut + 1)]);
    })),
  };

  const target = (yield* makeMemoryStore("two")).partition("acme");
  const seeded = yield* target.seed(racing);
  assert.equal(seeded.head, (yield* source.stats).compactedTo, "the copied log continues from the source's compaction point");
  yield* target.events.followAll(yield* events(source, { after: yield* target.events.head, limit: 1000 }));

  const state = (store) => Effect.map(Stream.runCollect(store.records), (all) =>
    [...all].map(({ seq, record }) => [Number(seq), record.live, record.version, record.live ? new TextDecoder().decode(record.body) : null]));
  assert.deepEqual(yield* state(target), yield* state(source), "every record, retired ones included, at its version");
  const { head, records, nextSeq } = yield* source.stats;
  const copied = yield* target.stats;
  assert.deepEqual([copied.head, copied.records, copied.nextSeq >= nextSeq], [head, records, true]);
  for (const word of ["atlas", "beacon", "cobalt", "delta", "w3"]) {
    assert.deepEqual(yield* seqs(target, term("title", word)), yield* seqs(source, term("title", word)), word);
  }
  assert.equal((yield* Effect.flip(target.seed(source)))._tag, "TenantNotEmpty", "a seed only starts from nothing");
})));

test("a write that saw no fence before its transaction is still refused when the fence lands first", () => run(Effect.gen(function* () {
  const store = (yield* makeMemoryStore("s0")).partition("acme");
  const docs = documentsFor(store, "acme");
  yield* docs.createCollection({ name: "posts" });

  // The fence goes on between the write's own check and its transaction: the
  // window a move's last catch-up could otherwise miss a write in.
  const fence = store.fence({ from: "s0", to: "s1" });
  let armed = true;
  const racing = {
    ...store,
    transact: (change) => {
      if (!armed) return store.transact(change);
      armed = false;
      return Effect.flatMap(fence, () => store.transact(change));
    },
  };
  const refused = yield* Effect.flip(documentsFor(racing, "acme").insert({ collection: "posts", id: "p1", data: {} }));
  assert.equal(refused._tag, "TenantMoving");
  assert.equal(yield* docs.findById({ collection: "posts", id: "p1" }), undefined, "and nothing landed");
})));

test("a seed cut off part way says so, so it is copied again rather than carried on from", () => run(Effect.gen(function* () {
  const source = (yield* makeMemoryStore("one")).partition("acme");
  // Enough postings for the seed to take more than one batch.
  for (let seq = 1; seq <= 1500; seq++) yield* put(source, seq, ["atlas", `w${seq % 40}`, `x${seq % 7}`]);

  const base = memoryKvEngine();
  let failAt = 0;
  let commits = 0;
  const engine = {
    ...base,
    conditionalWrite: (writes, conditions) =>
      failAt > 0 && ++commits === failAt
        ? Effect.fail(new StoreError({ op: "test.commit", cause: "cut off" }))
        : base.conditionalWrite(writes, conditions),
  };
  const shard = yield* openShardOverKv("two", engine);
  const target = shard.partition("acme");
  failAt = 2;
  assert.equal((yield* Effect.exit(target.seed(source)))._tag, "Failure");
  failAt = 0;
  const partial = yield* target.stats;
  assert.equal(partial.seeding, true, "the first batch landed and marks the copy unfinished");
  assert.ok(partial.records > 0 && partial.records < 1500);

  yield* shard.drop("acme");
  yield* target.seed(source);
  const finished = yield* target.stats;
  assert.equal(finished.seeding, false);
  assert.equal(finished.records, 1500);
  assert.deepEqual(yield* seqs(target, term("title", "atlas")), yield* seqs(source, term("title", "atlas")));
})));

