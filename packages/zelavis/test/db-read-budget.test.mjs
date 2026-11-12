// The work budget of a read on another Node: what it bounds, that it stops at the limit rather than
// eventually erroring, and that what fits answers exactly as an unbounded read does.
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { documentsFor } from "../dist/db/documents.js";
import { equals } from "../dist/db/index.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { ReadBudgetExceeded, StoreError } from "../dist/db/errors.js";
import { openShardOverKv, openShardReaderOverKv } from "../dist/db/kv-store.js";
import { makeReadBudget, DEFAULT_READ_LIMITS } from "../dist/db/read-budget.js";
import { GLOBAL_TENANT } from "../dist/db/topology.js";
import { TENANT_READ_OPS, jsonSizeWithin, tenantReadsOver, runTenantRead, encodeReadExit, decodeReadExit } from "../dist/db/tenant-reads.js";
import { instrumentedSqliteEngine, newStats } from "./_read-budget-fixture.mjs";

const run = (body) => Effect.runPromise(Effect.scoped(body));
const enc = new TextEncoder();
const MiB = 1024 * 1024;
const arrayBuffersMiB = () => process.memoryUsage().arrayBuffers / MiB;

/** The reason a failed exit failed: the budget's refusal is always a defect, never a typed failure. */
const refusal = (exit) => {
  assert.ok(Exit.isFailure(exit), "the read was expected to be refused");
  const reason = exit.cause.reasons[0];
  assert.equal(reason._tag, "Die");
  assert.ok(reason.defect instanceof ReadBudgetExceeded, `expected ReadBudgetExceeded, got ${String(reason.defect)}`);
  return reason.defect;
};

const bytes = (...list) => Uint8Array.from(list);
const key = (n) => bytes(1, n >> 8, n & 0xff);

test("the default limits are the documented ones", () => {
  assert.deepEqual(DEFAULT_READ_LIMITS, { bytes: 32 * MiB, entries: 262_144, postings: 4_194_304 });
  assert.throws(() => makeReadBudget({ bytes: -1 }), /non-negative safe integer/);
  assert.throws(() => makeReadBudget({ entries: 1.5 }), /non-negative safe integer/);
});

test("a budget spends nothing on a refusal and checks before it spends", () => {
  const budget = makeReadBudget({ bytes: 10, entries: 2, postings: 3 });
  budget.spend(1, 4);
  assert.throws(() => budget.spend(1, 7), (error) => error instanceof ReadBudgetExceeded && error.limit === "bytes" && error.max === 10);
  assert.deepEqual(budget.used(), { bytes: 4, entries: 1, postings: 0 });
  budget.spend(1, 6);
  assert.throws(() => budget.spend(1, 0), (error) => error.limit === "entries");
  budget.postings(3);
  assert.throws(() => budget.postings(1), (error) => error.limit === "postings" && error.max === 3);
  assert.deepEqual(budget.used(), { bytes: 10, entries: 2, postings: 3 });
});

test("a bounded SQLite get refuses a value larger than what is left without copying it", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  const big = new Uint8Array(96 * MiB).fill(7);
  yield* engine.write([{ op: "put", key: key(1), value: big }, { op: "put", key: key(2), value: bytes(9) }]);
  const reader = yield* engine.snapshot;
  const budget = makeReadBudget({ bytes: MiB });
  const before = arrayBuffersMiB();
  const defect = refusal(yield* Effect.exit(reader.bounded(budget).get(key(1))));
  assert.equal(defect.limit, "bytes");
  assert.ok(arrayBuffersMiB() - before < 4, "the refused value was not allocated");
  assert.equal(stats.getsRefused, 1);
  assert.equal(stats.getsCopied, 0);
  assert.deepEqual(budget.used(), { bytes: 3, entries: 1, postings: 0 }, "only the key was spent");
  // A value that fits is the unbounded read's answer, and an absent key costs its entry.
  assert.deepEqual(yield* reader.bounded(budget).get(key(2)), bytes(9));
  assert.equal(yield* reader.bounded(budget).get(key(3)), undefined);
  assert.deepEqual(budget.used(), { bytes: 3 + 3 + 1 + 3, entries: 3, postings: 0 });
  // The control: without the bound the same read allocates the whole value.
  const control = arrayBuffersMiB();
  const copied = yield* reader.get(key(1));
  assert.equal(copied.length, 96 * MiB);
  assert.ok(arrayBuffersMiB() - control > 64);
})));

test("a bounded scan answers what the unbounded scan answers while it fits", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engines = [yield* instrumentedSqliteEngine(stats), memoryKvEngine()];
  for (const engine of engines) {
    yield* engine.write(Array.from({ length: 700 }, (_, n) => ({ op: "put", key: key(n), value: new Uint8Array(1 + (n % 37)).fill(n % 251) })));
    yield* engine.write([{ op: "put", key: bytes(0, 5), value: bytes(1) }, { op: "put", key: bytes(2, 0), value: bytes(2) }]);
    const reader = yield* engine.snapshot;
    for (const options of [undefined, { reverse: true }, { limit: 10 }, { limit: 300 }, { reverse: true, limit: 300 }, { limit: 256 }, { limit: 257 },
      { from: key(100), to: key(600) }, { from: key(100), to: key(600), reverse: true }, { from: key(699) }, { to: key(1) }, { from: key(900) }]) {
      const budget = makeReadBudget();
      const want = [...(yield* Stream.runCollect(reader.scan(bytes(1), options)))];
      const got = [...(yield* Stream.runCollect(reader.bounded(budget).scan(bytes(1), options)))];
      assert.deepEqual(got, want, JSON.stringify(options));
      assert.deepEqual(budget.used(), { bytes: want.reduce((sum, entry) => sum + entry.key.length + entry.value.length, 0), entries: want.length, postings: 0 }, JSON.stringify(options));
    }
  }
})));

test("a bounded scan stops at its limit: the rows copied never pass the budget", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  yield* engine.write(Array.from({ length: 700 }, (_, n) => ({ op: "put", key: key(n), value: new Uint8Array(1000) })));
  const reader = yield* engine.snapshot;
  for (const [limits, field, rows] of [[{ entries: 300 }, "entries", 300], [{ bytes: 100 * 1003 }, "bytes", 100]]) {
    Object.assign(stats, newStats());
    const budget = makeReadBudget(limits);
    const defect = refusal(yield* Effect.exit(Stream.runCollect(reader.bounded(budget).scan(bytes(1)))));
    assert.equal(defect.limit, field);
    assert.equal(budget.used().entries, rows);
    assert.equal(stats.rowsCopied, rows, `${field}: the copies stop at the limit`);
    assert.ok(stats.rowsSized <= rows + 2 * 256, `${field}: sizing looks ahead one page at most (${stats.rowsSized})`);
  }
  // A scan that asks for no more than the budget never feels it, however large the range behind it.
  Object.assign(stats, newStats());
  const small = makeReadBudget({ entries: 10 });
  assert.equal([...(yield* Stream.runCollect(reader.bounded(small).scan(bytes(1), { limit: 10 })))].length, 10);
  assert.equal(stats.rowsCopied, 10);
})));

test("a bounded scan refuses a row too large before copying it, and a refusal leaves the engine usable", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  yield* engine.write([{ op: "put", key: key(1), value: bytes(1) }, { op: "put", key: key(2), value: bytes(2) },
    { op: "put", key: key(3), value: new Uint8Array(64 * MiB) }, { op: "put", key: key(4), value: bytes(4) }]);
  const reader = yield* engine.snapshot;
  const budget = makeReadBudget({ bytes: MiB });
  const before = arrayBuffersMiB();
  Object.assign(stats, newStats());
  const defect = refusal(yield* Effect.exit(Stream.runCollect(reader.bounded(budget).scan(bytes(1)))));
  assert.equal(defect.limit, "bytes");
  assert.equal(stats.rowsCopied, 2, "the two rows before the large one were copied; it was not");
  assert.ok(stats.bytesCopied < 16);
  assert.ok(arrayBuffersMiB() - before < 4, "the large row was not allocated");
  // The same snapshot still reads, and a snapshot taken and released leaves no transaction open.
  assert.equal([...(yield* Stream.runCollect(reader.bounded(makeReadBudget()).scan(bytes(1), { limit: 2 })))].length, 2);
  const taken = stats.begins;
  yield* Effect.scoped(Effect.flatMap(engine.snapshot, (snapshot) => Effect.exit(Stream.runCollect(snapshot.bounded(makeReadBudget({ entries: 1 })).scan(bytes(1))))));
  assert.equal(stats.begins, taken + 1);
  assert.equal(stats.rollbacks, stats.begins, "the refused read's snapshot was released");
})));

test("a bounded scan is refused on an engine's own connection, which has no one view to page through", () => run(Effect.gen(function* () {
  const engine = yield* instrumentedSqliteEngine(newStats());
  yield* engine.write([{ op: "put", key: key(1), value: bytes(1) }]);
  const error = yield* Effect.flip(Stream.runCollect(engine.bounded(makeReadBudget()).scan(bytes(1))));
  assert.ok(error instanceof StoreError);
  assert.match(String(error.cause), /needs a snapshot/);
  assert.deepEqual(yield* engine.bounded(makeReadBudget()).get(key(1)), bytes(1));
})));

/** A database written through the documents API on one engine. */
const seeded = (engine, count, { size = 20, shared } = {}) => Effect.gen(function* () {
  const writer = yield* openShardOverKv("s", engine);
  const docs = documentsFor(writer.partition("t"), "t");
  yield* docs.createCollection({ name: "notes", columns: ["category"], analyzer: { fields: ["title"], version: 1 } });
  for (let from = 0; from < count; from += 500) {
    yield* docs.write({ operations: Array.from({ length: Math.min(500, count - from) }, (_, i) => ({ _tag: "Insert", collection: "notes", id: `n${from + i}`,
      data: { title: `alpha beta${(from + i) % 7}`, category: (from + i) % 2 === 0 ? "even" : "odd", body: "x".repeat(size) } })) });
  }
  if (shared !== undefined) {
    const global = documentsFor(writer.partition(GLOBAL_TENANT), GLOBAL_TENANT);
    yield* global.createCollection({ name: "plans" });
    for (let i = 0; i < shared; i++) yield* global.insert({ collection: "plans", id: `p${i}`, data: { seats: i, body: "y".repeat(size) } });
  }
  return { writer, docs };
});

const readerApi = (engine, budget) => Effect.map(openShardReaderOverKv("s", engine, { budget }), (reader) =>
  tenantReadsOver(reader.partition("t"), reader.partition(GLOBAL_TENANT), "t"));

test("an unbounded findMany is refused at the limit and reads no further", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  const { docs } = yield* seeded(engine, 3000);
  Object.assign(stats, newStats());
  const budget = makeReadBudget({ entries: 1000 });
  const api = yield* readerApi(engine, budget);
  const defect = refusal(yield* Effect.exit(runTenantRead(api, "documents.findMany", { collection: "notes" })));
  assert.equal(defect.limit, "entries");
  assert.ok(budget.used().entries <= 1000);
  assert.ok(stats.rowsCopied + stats.getsCopied <= 1000, `copied ${stats.rowsCopied + stats.getsCopied} entries under a limit of 1000`);
  assert.equal(stats.begins, stats.rollbacks, "the refused read's snapshot was released");
  // With room it is the local answer, to the document.
  const roomy = makeReadBudget();
  const full = yield* Effect.exit(runTenantRead(yield* readerApi(engine, roomy), "documents.findMany", { collection: "notes" }));
  const local = yield* docs.findMany({ collection: "notes" });
  assert.deepEqual(JSON.parse(JSON.stringify(full.value)), JSON.parse(JSON.stringify(local)));
  assert.ok(roomy.used().entries > 3000);
})));

test("a posting set is charged for the identifiers it expands to, not the bytes it is stored in", () => run(Effect.gen(function* () {
  const engine = yield* instrumentedSqliteEngine(newStats());
  const writer = yield* openShardOverKv("s", engine);
  const part = writer.partition("t");
  const N = 70_000;
  for (let from = 1; from <= N; from += 5000) {
    yield* part.transact((txn) => Effect.forEach(Array.from({ length: Math.min(5000, N - from + 1) }, (_, i) => from + i),
      (seq) => txn.put(seq, enc.encode(`{"n":${seq}}`), { terms: [], columns: [["category", "a"]], measures: [], edges: [] }), { discard: true }));
  }
  const seal = yield* part.sealPostings;
  assert.equal(seal.postings, N);
  const budget = makeReadBudget({ postings: 10_000 });
  const reader = (yield* openShardReaderOverKv("s", engine, { budget })).partition("t");
  const defect = refusal(yield* Effect.exit(reader.reading(Stream.runCollect(reader.resolve(equals("category", "a"))))));
  assert.equal(defect.limit, "postings");
  assert.equal(budget.used().postings, 10_000, "the expansion stopped exactly at the limit");
  assert.ok(budget.used().bytes < 64 * 1024, `the sealed blobs are small (${budget.used().bytes} bytes): bytes alone would not have stopped it`);
  const roomy = makeReadBudget();
  const readerAll = (yield* openShardReaderOverKv("s", engine, { budget: roomy })).partition("t");
  const ids = [...(yield* readerAll.reading(Stream.runCollect(readerAll.resolve(equals("category", "a")))))];
  assert.equal(ids.length, N);
  assert.equal(roomy.used().postings, N);
  // The windowed path and the ordered path expand through the same charge.
  const paged = makeReadBudget({ postings: 5 });
  const readerPaged = (yield* openShardReaderOverKv("s", engine, { budget: paged })).partition("t");
  refusal(yield* Effect.exit(readerPaged.reading(Stream.runCollect(readerPaged.resolve(equals("category", "a"), { limit: 1000 })))));
  const ordered = makeReadBudget({ postings: 1000 });
  const readerOrdered = (yield* openShardReaderOverKv("s", engine, { budget: ordered })).partition("t");
  const page = yield* Effect.exit(readerOrdered.reading(readerOrdered.ordered({ column: "category", limit: 50 })));
  assert.equal(refusal(page).limit, "postings", "an ordered read expands a whole sealed blob to its keys, and is charged for each");
  assert.equal(ordered.used().postings, 1000);
})));

test("searchStatistics, a large payload and shared reads are bounded like any other read", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  const { docs } = yield* seeded(engine, 400, { shared: 30 });
  yield* docs.insert({ collection: "notes", id: "huge", data: { title: "alpha huge", category: "huge", body: "z".repeat(8 * MiB) } });
  // The 8 MiB document is refused unread when its read does not fit.
  Object.assign(stats, newStats());
  const before = arrayBuffersMiB();
  const defect = refusal(yield* Effect.exit(runTenantRead(yield* readerApi(engine, makeReadBudget({ bytes: MiB })), "documents.findById", { collection: "notes", id: "huge" })));
  assert.equal(defect.limit, "bytes");
  assert.ok(stats.getsRefused >= 1, "the store refused the value in its own statement");
  assert.ok(stats.getBytesCopied < MiB, `copied ${stats.getBytesCopied} bytes of values`);
  assert.ok(arrayBuffersMiB() - before < 4, "the large payload was not allocated");
  // The statistics over the text lens spend entries, and stop at the limit.
  const searching = makeReadBudget({ entries: 50 });
  assert.equal(refusal(yield* Effect.exit(runTenantRead(yield* readerApi(engine, searching), "documents.searchStatistics", { collection: "notes", search: "alpha" }))).limit, "entries");
  assert.ok(searching.used().entries <= 50);
  // One budget covers the Tenant's partition and the shared one.
  const probe = makeReadBudget();
  const one = yield* readerApi(engine, probe);
  yield* runTenantRead(one, "documents.findMany", { collection: "notes", where: [{ path: "category", value: "even" }], limit: 5 });
  const afterTenant = probe.used().entries;
  yield* runTenantRead(one, "shared.findMany", { collection: "plans" });
  assert.ok(probe.used().entries > afterTenant + 30, "the shared read spent from the same budget");
  const both = makeReadBudget({ entries: afterTenant + 10 });
  const shared = yield* readerApi(engine, both);
  yield* runTenantRead(shared, "documents.findMany", { collection: "notes", where: [{ path: "category", value: "even" }], limit: 5 });
  assert.equal(refusal(yield* Effect.exit(runTenantRead(shared, "shared.findMany", { collection: "plans" }))).limit, "entries");
})));

test("reads that run together spend independent budgets and leave no snapshot behind", () => run(Effect.gen(function* () {
  const stats = newStats();
  const engine = yield* instrumentedSqliteEngine(stats);
  yield* seeded(engine, 1500);
  Object.assign(stats, newStats());
  const limits = [100, 20_000, 200, 30_000, 300, 25_000];
  const budgets = limits.map((entries) => makeReadBudget({ entries }));
  const exits = yield* Effect.forEach(budgets, (budget) => Effect.flatMap(readerApi(engine, budget), (api) =>
    Effect.exit(runTenantRead(api, "documents.findMany", { collection: "notes" }))), { concurrency: "unbounded" });
  exits.forEach((exit, at) => {
    if (limits[at] < 1500 * 5) { assert.equal(refusal(exit).limit, "entries"); assert.ok(budgets[at].used().entries <= limits[at]); }
    else { assert.ok(Exit.isSuccess(exit)); assert.equal(exit.value.length, 1500); assert.ok(budgets[at].used().entries > 1500); }
  });
  assert.equal(stats.begins, stats.rollbacks, "every snapshot taken was released");
})));

test("an engine that cannot bound its reads is refused, never read without a bound", () => run(Effect.gen(function* () {
  const unbounded = { ...memoryKvEngine(), bounded: undefined };
  yield* openShardOverKv("s", unbounded);
  const error = yield* Effect.flip(openShardReaderOverKv("s", unbounded, { budget: makeReadBudget() }));
  assert.ok(error instanceof StoreError);
  assert.match(String(error.cause), /cannot bound its reads/);
  const noSnapshot = memoryKvEngine();
  yield* openShardOverKv("s", noSnapshot);
  const lacking = yield* Effect.flip(openShardReaderOverKv("s", { ...noSnapshot, snapshot: Effect.map(noSnapshot.snapshot, (taken) => ({ get: taken.get, scan: taken.scan })) }, { budget: makeReadBudget() })
    .pipe(Effect.flatMap((reader) => reader.partition("t").reading(Effect.void))));
  assert.ok(lacking instanceof StoreError);
  assert.match(String(lacking.cause), /snapshot cannot bound/);
})));

test("the refusal crosses the read codec as itself", () => {
  const body = JSON.parse(JSON.stringify(encodeReadExit(Exit.die(new ReadBudgetExceeded({ limit: "postings", max: 7 })))));
  assert.deepEqual(body, { defect: { _tag: "ReadBudgetExceeded", limit: "postings", max: 7 } });
  const exit = Effect.runSync(Effect.exit(decodeReadExit("documents.count", body)));
  const defect = refusal(exit);
  assert.equal(defect.limit, "postings");
  assert.equal(defect.max, 7);
});

test("the size of an answer is counted exactly without building it", () => {
  const samples = [null, true, false, 0, -0, 1.5, -2e21, 1e-7, "", "plain", "quote \" slash \\ \b\f\n\r\t", "\u0000\u001f\u007f", "é ü", "日本語", "😀 pair", "lone \ud800 high", "lone \udc00 low",
    [], {}, [1, [2, [3, []]]], { a: 1, b: { c: [true, null, "x"] }, "ключ": "значение", "k\"ey": 0 }, { skipped: undefined, kept: 1 }, [undefined, 1], { "": "" }];
  for (const sample of samples) {
    assert.equal(jsonSizeWithin(sample, Number.MAX_SAFE_INTEGER), Buffer.byteLength(JSON.stringify(sample)), JSON.stringify(sample));
  }
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const text = () => Array.from({ length: Math.floor(next() * 12) }, () => String.fromCharCode(Math.floor(next() * 0x3000) + (next() < 0.2 ? 0xd7f0 : 0))).join("");
  const value = (depth) => next() < 0.3 || depth > 3 ? [text(), Math.floor(next() * 1e6) / 7, next() < 0.5, null][Math.floor(next() * 4)]
    : next() < 0.5 ? Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1)) : Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [text(), value(depth + 1)]));
  for (let i = 0; i < 500; i++) {
    const sample = value(0);
    assert.equal(jsonSizeWithin(sample, Number.MAX_SAFE_INTEGER), Buffer.byteLength(JSON.stringify(sample)), JSON.stringify(sample));
  }
  const text100 = "x".repeat(100);
  assert.equal(jsonSizeWithin(text100, 101), undefined);
  assert.equal(jsonSizeWithin(text100, 102), 102);
  assert.equal(jsonSizeWithin([text100, text100, text100], 250), undefined);
});

test("every listed read is answered exactly or refused within its limits, whichever limit is tight", () => run(Effect.gen(function* () {
  const stats = newStats();
  const { buildReadsFixture, readInputs } = yield* Effect.promise(() => import("./_tenant-reads-fixture.mjs"));
  const { db, docs, engines } = yield* buildReadsFixture(() => Effect.succeed(undefined).pipe(Effect.andThen(instrumentedSqliteEngine(stats))));
  for (let from = 0; from < 1200; from += 400) {
    yield* docs.write({ operations: Array.from({ length: 400 }, (_, i) => ({ _tag: "Insert", collection: "notes", id: `bulk${from + i}`,
      data: { title: `alpha word${(from + i) % 11}`, category: `c${(from + i) % 5}`, authorId: "p", x: (from + i) % 97, y: ((from + i) * 3) % 89, vec: [1, (from + i) % 3] } })) });
  }
  const rows = (yield* docs.findMany({ collection: "notes", limit: 40 }));
  const { inputs, failures } = readInputs(rows);
  const engine = engines.get(db.shardOf("t"));
  const shape = (exit) => JSON.parse(JSON.stringify(encodeReadExit(exit)));
  const answer = (op, input, limits) => Effect.gen(function* () {
    const budget = makeReadBudget(limits);
    Object.assign(stats, newStats());
    const opened = yield* Effect.exit(openShardReaderOverKv(db.shardOf("t"), engine, { budget }));
    if (Exit.isFailure(opened)) return { exit: opened, budget };
    const reader = opened.value;
    const api = tenantReadsOver(reader.partition("t"), reader.partition(GLOBAL_TENANT), "t");
    return { exit: yield* Effect.exit(runTenantRead(api, op, JSON.parse(JSON.stringify(input)))), budget };
  });
  const roomy = { entries: 1e9, bytes: 1e12, postings: 1e9 };
  const tight = [...[0, 1, 3, 10, 100, 1000, 6000].map((entries) => ({ entries })), ...[0, 100, 10_000, 200_000].map((bytes) => ({ bytes })),
    ...[0, 5, 100, 5000].map((postings) => ({ postings })), { entries: 20, bytes: 2000, postings: 20 }];
  let refused = 0, exact = 0;
  for (const op of TENANT_READ_OPS) for (const input of [inputs[op], ...(failures[op] ?? [])]) {
    const baseline = shape((yield* answer(op, input, roomy)).exit);
    for (const limits of tight) {
      const limit = { ...roomy, ...limits };
      const { exit, budget } = yield* answer(op, input, limit);
      const label = `${op} ${JSON.stringify(input).slice(0, 60)} under ${JSON.stringify(limits)}`;
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
      if (reason?._tag === "Die" && reason.defect instanceof ReadBudgetExceeded) {
        refused += 1;
        assert.ok(Object.keys(limits).includes(reason.defect.limit), `${label}: refused by ${reason.defect.limit}`);
      } else {
        exact += 1;
        assert.deepEqual(shape(exit), baseline, label);
      }
      const used = budget.used();
      assert.ok(used.entries <= limit.entries && used.bytes <= limit.bytes && used.postings <= limit.postings, `${label}: spent ${JSON.stringify(used)}`);
      assert.ok(stats.rowsCopied + stats.getsCopied <= limit.entries, `${label}: copied ${stats.rowsCopied + stats.getsCopied} entries`);
      assert.ok(stats.bytesCopied + stats.getBytesCopied <= limit.bytes, `${label}: copied ${stats.bytesCopied + stats.getBytesCopied} bytes`);
    }
  }
  assert.ok(refused > 100 && exact > 100, `the sweep covered both outcomes (${refused} refused, ${exact} answered)`);
  assert.equal(stats.begins, stats.rollbacks, "every snapshot taken was released");
})));
