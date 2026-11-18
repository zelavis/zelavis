/**
 * The Auth module runtime: tables, the database adapter inside a
 * transaction, the token-bucket limiter, the sealed email outbox relay and
 * sweeps. Every Auth module stands on these.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  AuthInvariantViolation, MINUTE, createAuthOutboxRelay, defineRateLimits, defineSweep, defineTable, defineTables,
  ensureTables, limiterTables, startSweeps,
} from "../dist/auth/runtime/index.js";
import { authTestRuntime, openAuthTestTenant, recordingOutbox, TEST_MASTER_SECRET } from "./_auth.mjs";

const request = { ip: "203.0.113.7" };
const t_ = defineTables("t", {
  rows: defineTable({ a: Schema.Number, b: Schema.Number, label: Schema.optional(Schema.String) }).index("by_ab", ["a", "b"]),
});

const defectOf = (effect) => Effect.map(Effect.exit(effect), (exit) => {
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Cause.squash(exit.cause);
});

async function setup(t, tables = { ...t_, ...limiterTables }) {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, tables));
  return { tenant, ...authTestRuntime(tenant) };
}

const seed = (runtime, clock) => Effect.gen(function* () {
  for (const [a, b] of [[1, 1], [1, 2], [1, 3], [2, 1]]) {
    yield* runtime.mutation(request, (tx) => tx.db.insert(t_.rows, { a, b }));
    clock.now += 1;
  }
});

test("ensureTables creates each collection once and adds a new index", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, t_));
  await Effect.runPromise(ensureTables(tenant, t_));
  const collections = await Effect.runPromise(tenant.documents.listCollections);
  const rows = collections.filter((collection) => collection.name === "t_rows");
  assert.equal(rows.length, 1);
  assert.deepEqual(new Set(rows[0].columns), new Set(["a", "b", "_creationTime"]));
  assert.deepEqual(rows[0].indexes.map((index) => index.name).sort(), ["by_ab", "by_creation_time"]);
  const wider = defineTables("t", {
    rows: defineTable({ a: Schema.Number, b: Schema.Number, label: Schema.optional(Schema.String) }).index("by_ab", ["a", "b"]).index("by_label", ["label"]),
  });
  await Effect.runPromise(ensureTables(tenant, wider));
  const after = (await Effect.runPromise(tenant.documents.listCollections)).find((collection) => collection.name === "t_rows");
  assert.deepEqual(after.indexes.map((index) => index.name).sort(), ["by_ab", "by_creation_time", "by_label"]);
  assert.ok(after.columns.includes("label"));
});

test("withIndex ranges, order and terminals follow index semantics", async (t) => {
  const { runtime, clock } = await setup(t);
  await Effect.runPromise(Effect.gen(function* () {
    yield* seed(runtime, clock);
    yield* runtime.mutation(request, (tx) => Effect.gen(function* () {
      const range = () => tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 1).gte("b", 2));
      assert.deepEqual((yield* range().collect()).map((row) => row.b), [2, 3]);
      assert.equal((yield* range().order("desc").first()).b, 3);
      assert.equal((yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 2)).unique()).b, 1);
      assert.equal(yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 3)).unique(), null);
      assert.equal((yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 1)).take(2)).length, 2);
      assert.deepEqual((yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 1).gt("b", 1).lt("b", 3)).collect()).map((row) => row.b), [2]);
      // The built-in creation-time index, and a query with no index at all, read in insertion order.
      assert.deepEqual((yield* tx.db.query(t_.rows).collect()).map((row) => [row.a, row.b]), [[1, 1], [1, 2], [1, 3], [2, 1]]);
      assert.deepEqual((yield* tx.db.query(t_.rows).order("desc").first()).a, 2);
    }));
  }));
});

test("misuse of the data model dies with AuthInvariantViolation", async (t) => {
  const { runtime, clock } = await setup(t);
  await Effect.runPromise(seed(runtime, clock));
  const dies = async (body, pattern) => {
    const defect = await Effect.runPromise(defectOf(runtime.mutation(request, body)));
    assert.ok(defect instanceof AuthInvariantViolation, `expected AuthInvariantViolation, got ${defect}`);
    assert.match(defect.message, pattern);
  };
  await dies((tx) => tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 1)).unique(), /unique\(\) found two rows/);
  await dies((tx) => tx.db.query(t_.rows).withIndex("by_ab", (q) => q.gte("b", 2)).collect(), /must follow equalities/);
  await dies((tx) => tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("b", 2)).collect(), /must name the next index field/);
  await dies((tx) => tx.db.query(t_.rows).withIndex("by_nothing").first(), /has no index by_nothing/);
  await dies((tx) => tx.db.query(t_.rows).take(1001), /take\(1001\)/);
  await dies((tx) => tx.db.patch(t_.rows, "0".repeat(32), { b: 9 }), /patch on a missing/);
  await dies((tx) => tx.db.insert(t_.rows, { a: "not a number", b: 1 }), /does not match its table/);
});

test("ties in every index field order by _creationTime", async (t) => {
  const { runtime } = await setup(t);
  // The clock stands still: creation times still strictly increase.
  const ids = await Effect.runPromise(Effect.gen(function* () {
    const inserted = [];
    for (let i = 0; i < 3; i += 1) inserted.push(yield* runtime.mutation(request, (tx) => tx.db.insert(t_.rows, { a: 5, b: 5, label: `n${i}` })));
    return inserted;
  }));
  await Effect.runPromise(runtime.query(request, (tx) => Effect.gen(function* () {
    const rows = yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 5).eq("b", 5)).collect();
    assert.deepEqual(rows.map((row) => row._id), ids);
    assert.ok(rows[0]._creationTime < rows[1]._creationTime && rows[1]._creationTime < rows[2]._creationTime);
    assert.deepEqual((yield* tx.db.query(t_.rows).withIndex("by_ab", (q) => q.eq("a", 5)).order("desc").collect()).map((row) => row._id), [...ids].reverse());
  })));
});

test("writes: insert, get, patch, replace, delete and normalizeId", async (t) => {
  const { runtime, clock } = await setup(t);
  const id = await Effect.runPromise(runtime.mutation(request, (tx) => Effect.gen(function* () {
    const inserted = yield* tx.db.insert(t_.rows, { a: 1, b: 1, label: "x" });
    assert.match(inserted, /^[0-9a-f]{32}$/);
    const read = yield* tx.db.get(t_.rows, inserted);
    assert.equal(read.label, "x");
    assert.equal(read._creationTime, clock.now);
    return inserted;
  })));
  await Effect.runPromise(runtime.mutation(request, (tx) => Effect.gen(function* () {
    const before = yield* tx.db.get(t_.rows, id);
    yield* tx.db.patch(t_.rows, id, { b: 2 });
    assert.deepEqual(yield* tx.db.get(t_.rows, id), { ...before, b: 2 });
    yield* tx.db.patch(t_.rows, id, { label: undefined }); // undefined removes a field
    assert.equal("label" in (yield* tx.db.get(t_.rows, id)), false);
    yield* tx.db.replace(t_.rows, id, { a: 7, b: 8 });
    const replaced = yield* tx.db.get(t_.rows, id);
    assert.deepEqual(replaced, { a: 7, b: 8, _id: id, _creationTime: before._creationTime });
    yield* tx.db.delete(t_.rows, id);
    assert.equal(yield* tx.db.get(t_.rows, id), null);
    assert.equal(tx.db.normalizeId(t_.rows, "zz"), null);
    assert.equal(tx.db.normalizeId(t_.rows, id), id);
  })));
  assert.equal(await Effect.runPromise(runtime.query(request, (tx) => tx.db.get(t_.rows, id))), null);
});

test("a mutation that dies writes nothing, and a query cannot write", async (t) => {
  const { runtime } = await setup(t);
  const defect = await Effect.runPromise(defectOf(runtime.mutation(request, (tx) => Effect.gen(function* () {
    yield* tx.db.insert(t_.rows, { a: 1, b: 1 });
    yield* tx.db.insert(t_.rows, { a: 1, b: 2 });
    return yield* Effect.die(new AuthInvariantViolation({ message: "roll back" }));
  }))));
  assert.equal(defect.message, "roll back");
  assert.equal((await Effect.runPromise(runtime.query(request, (tx) => tx.db.query(t_.rows).collect()))).length, 0);
  const refused = await Effect.runPromise(defectOf(runtime.query(request, (tx) => tx.db.insert(t_.rows, { a: 1, b: 1 }))));
  assert.match(refused.message, /insert into t_rows in a query/);
});

test("the request context is the trusted client address", async (t) => {
  const { runtime } = await setup(t);
  assert.equal(await Effect.runPromise(runtime.query(request, (tx) => Effect.succeed(tx.request.ip))), "203.0.113.7");
});

test("token bucket: capacity, refusal with retryAfter, refill, and check does not consume", async (t) => {
  const { runtime, clock, tenant } = await setup(t);
  const limits = defineRateLimits("password", { verifyPassword: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 5 } });
  const limit = () => Effect.runPromise(runtime.mutation(request, (tx) => limits.limit(tx, "verifyPassword", { key: "alice@example.com" })));
  const check = () => Effect.runPromise(runtime.query(request, (tx) => limits.check(tx, "verifyPassword", { key: "alice@example.com" })));
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await limit(), { ok: true });
  const refused = await limit();
  assert.equal(refused.ok, false);
  assert.ok(Math.abs(refused.retryAfter - 60_000) <= 1, `retryAfter ${refused.retryAfter}`);
  clock.now += 60_000;
  assert.deepEqual(await check(), { ok: true });
  assert.deepEqual(await check(), { ok: true });
  assert.deepEqual(await limit(), { ok: true });
  assert.equal((await limit()).ok, false);
  // Another key has its own bucket.
  assert.deepEqual(await Effect.runPromise(runtime.mutation(request, (tx) => limits.limit(tx, "verifyPassword", { key: "bob@example.com" }))), { ok: true });
  const stored = await Effect.runPromise(tenant.documents.findMany({ collection: "limiter_buckets", limit: 10 }));
  assert.equal(stored.length, 2);
  for (const bucket of stored) {
    assert.match(bucket.data.bucket, /^password:verifyPassword:[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(bucket.data).includes("example.com"));
  }
});

const payload = { kind: "email-verification", to: "alice@example.com", subject: "Your sign-in code 123456", text: "Code 123456", html: "<p>Code 123456</p>" };

test("relay: a committed emit is delivered once, sealed at rest, and kept while email is disabled", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, t_));
  const outbox = recordingOutbox();
  const relay = createAuthOutboxRelay({ tenant, outbox, masterSecret: TEST_MASTER_SECRET });
  let woken = 0;
  const { runtime } = authTestRuntime(tenant, { relay: { wake: () => { woken += 1; } } });
  await Effect.runPromise(runtime.mutation(request, (tx) => Effect.gen(function* () {
    yield* tx.db.insert(t_.rows, { a: 1, b: 1 });
    yield* tx.emit({ topic: "auth.email", id: "m1", payload });
  })));
  assert.equal(woken, 1);
  const stored = await Effect.runPromise(tenant.outbox.read({ topic: "auth.email" }));
  assert.equal(stored.messages.length, 1);
  assert.ok(!JSON.stringify(stored.messages[0].payload).includes("123456"), "the payload is sealed");
  assert.equal("subject" in stored.messages[0].payload, false);

  outbox.disabled = true;
  assert.equal(await Effect.runPromise(relay.run), 0);
  assert.equal(outbox.delivered.length, 0);
  assert.equal((await Effect.runPromise(tenant.outbox.read({ topic: "auth.email" }))).messages.length, 1);

  outbox.disabled = false;
  assert.equal(await Effect.runPromise(relay.run), 1);
  assert.equal(await Effect.runPromise(relay.run), 0);
  assert.equal(outbox.delivered.length, 1);
  assert.equal(outbox.delivered[0].id, "m1");
  assert.equal(outbox.delivered[0].subject, payload.subject);
  assert.equal((await Effect.runPromise(tenant.outbox.read({ topic: "auth.email" }))).messages.length, 0);

  // A second relay (a new process) reads the log from the start: nothing is sent again.
  const again = createAuthOutboxRelay({ tenant, outbox, masterSecret: TEST_MASTER_SECRET });
  assert.equal(await Effect.runPromise(again.run), 0);
  assert.equal(outbox.delivered.length, 1);
});

test("relay: a message stopped between hand-off and removal is still delivered once", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, t_));
  const outbox = recordingOutbox();
  const { runtime } = authTestRuntime(tenant);
  await Effect.runPromise(runtime.mutation(request, (tx) => tx.emit({ topic: "auth.email", id: "m2", payload })));
  // The email outbox already took it (as if the relay stopped before removing it).
  await Effect.runPromise(outbox.enqueue({ id: "m2", ...payload }));
  const relay = createAuthOutboxRelay({ tenant, outbox, masterSecret: TEST_MASTER_SECRET });
  await Effect.runPromise(relay.run);
  assert.equal(outbox.delivered.length, 1);
  assert.equal((await Effect.runPromise(tenant.outbox.read({ topic: "auth.email" }))).messages.length, 0);
});

test("relay: a message sealed with another key is removed, not sent", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, t_));
  const outbox = recordingOutbox();
  const other = createAuthOutboxRelay({ tenant, outbox, masterSecret: "another-secret" });
  const { runtime } = authTestRuntime(tenant);
  await Effect.runPromise(runtime.mutation(request, (tx) => tx.emit({ topic: "auth.email", id: "m3", payload })));
  await Effect.runPromise(other.run);
  assert.equal(outbox.delivered.length, 0);
  assert.equal((await Effect.runPromise(tenant.outbox.read({ topic: "auth.email" }))).messages.length, 0);
});

test("relay: start runs on wake and stop ends it", async (t) => {
  const { tenant } = await openAuthTestTenant(t);
  await Effect.runPromise(ensureTables(tenant, t_));
  const outbox = recordingOutbox();
  const relay = createAuthOutboxRelay({ tenant, outbox, masterSecret: TEST_MASTER_SECRET, everyMs: 60_000 });
  const running = await Effect.runPromise(relay.start());
  const { runtime } = authTestRuntime(tenant, { relay });
  await Effect.runPromise(runtime.mutation(request, (tx) => tx.emit({ topic: "auth.email", id: "m4", payload })));
  for (let i = 0; i < 100 && outbox.delivered.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(outbox.delivered.length, 1);
  await Effect.runPromise(running.stop());
});

test("sweep: a failed run is logged and the sweep runs again; stop interrupts it", async () => {
  let runs = 0;
  const sweep = defineSweep({
    name: "test",
    everyMs: 1000,
    run: () => Effect.suspend(() => {
      runs += 1;
      return runs === 1 ? Effect.fail(new Error("first run fails")) : Effect.succeed(200); // a full batch runs again after 1 s
    }),
  });
  const running = await Effect.runPromise(startSweeps(undefined, [sweep]));
  for (let i = 0; i < 300 && runs < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(runs >= 3, `ran ${runs} times`);
  await Effect.runPromise(running.stop());
  const stopped = runs;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(runs, stopped);
});
