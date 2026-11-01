// Sagas on the database's durable workflow engine: a workflow spanning Tenants records each completed step and
// never runs it again (a restart included), compensates completed steps when a later one fails, writes each Tenant
// exactly once through idempotency keys, and is started from a Tenant's outbox exactly once per message.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { Activity, Workflow } from "effect/workflow";
import { makeDatabase, partitionMapFor, startFromOutbox, tenantWriteActivity } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const open = (dir) => makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), crossTenantRefresh: false, openShard: (shard) => makeNodeSqliteStore(shard, dir) });
const balance = (db, tenant) => Effect.map(db.forTenant(tenant).documents.findById({ collection: "accounts", id: "main" }), (doc) => doc?.data.balance);

const Transfer = Workflow.make("Transfer", {
  payload: { id: Schema.String, amount: Schema.Number, failAfterDebit: Schema.Boolean },
  idempotencyKey: ({ id }) => id,
});

/** Debit one Tenant, credit another; the debit is undone if anything after it fails. */
const transferLayer = (db, hooks) => Transfer.toLayer(Effect.fnUntraced(function* (payload) {
  const move = (tenant, delta, name) => tenantWriteActivity({
    name, success: Schema.Number,
    write: (idempotencyKey) => Effect.gen(function* () {
      hooks.ran[name] = (hooks.ran[name] ?? 0) + 1;
      const handle = db.forTenant(tenant).documents;
      const current = yield* handle.findById({ collection: "accounts", id: "main" });
      yield* handle.write({ operations: [{ _tag: "Update", collection: "accounts", id: "main", data: { balance: current.data.balance + delta }, expectedVersion: current.version }], idempotencyKey });
      return current.data.balance + delta;
    }).pipe(Effect.orDie),
  });
  yield* move("alice", -payload.amount, "debit").pipe(
    Workflow.withCompensation(() => Effect.asVoid(Effect.orDie(move("alice", payload.amount, "refund")))),
  );
  if (hooks.pause) yield* Deferred.await(hooks.pause);
  if (payload.failAfterDebit) yield* Activity.make({ name: "boom", execute: Effect.die("the credit failed") });
  yield* move("bob", payload.amount, "credit");
}));

const seed = (db) => Effect.gen(function* () {
  for (const tenant of ["alice", "bob"]) {
    yield* db.forTenant(tenant).documents.createCollection({ name: "accounts" });
    yield* db.forTenant(tenant).documents.insert({ collection: "accounts", id: "main", data: { balance: 100 } });
  }
});

test("a saga across Tenants completes, and a failure after a step runs its compensation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-saga-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    yield* seed(db);
    const hooks = { ran: {} };
    yield* Effect.gen(function* () {
      yield* Transfer.execute({ id: "t1", amount: 30, failAfterDebit: false });
      assert.deepEqual([yield* balance(db, "alice"), yield* balance(db, "bob")], [70, 130]);
      const failed = yield* Effect.exit(Transfer.execute({ id: "t2", amount: 50, failAfterDebit: true }));
      assert.equal(failed._tag, "Failure");
      assert.deepEqual([yield* balance(db, "alice"), yield* balance(db, "bob")], [70, 130], "the debit was compensated");
      // Running a finished execution again answers from its record.
      yield* Transfer.execute({ id: "t1", amount: 30, failAfterDebit: false });
      assert.equal(hooks.ran.debit, 2, "t1 and t2 each debited once");
    }).pipe(Effect.provide(Layer.provideMerge(transferLayer(db, hooks), db.workflowEngine)));
  })));
});

test("a saga cut off by a restart resumes without running a recorded step again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-saga-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = { ran: {} };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    yield* seed(db);
    first.pause = yield* Deferred.make();
    yield* Effect.gen(function* () {
      yield* Transfer.execute({ id: "t3", amount: 10, failAfterDebit: false }, { discard: true });
      for (let tries = 0; tries < 200 && first.ran.debit !== 1; tries++) yield* Effect.sleep("5 millis");
      yield* Effect.sleep("20 millis");
      assert.equal(yield* balance(db, "alice"), 90, "debited before the restart");
    }).pipe(Effect.provide(Layer.provideMerge(transferLayer(db, first), db.workflowEngine)));
  })));
  const second = { ran: {} };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    yield* Effect.gen(function* () {
      // Registering the workflow resumed it; polling waits for its recorded result.
      let result;
      const executionId = yield* Transfer.executionId({ id: "t3", amount: 10, failAfterDebit: false });
      for (let tries = 0; tries < 400 && result === undefined; tries++) {
        const polled = yield* Transfer.poll(executionId);
        if (polled._tag === "Some" && polled.value._tag === "Complete") result = polled.value;
        else yield* Effect.sleep("5 millis");
      }
      assert.ok(result, "the execution finished after the restart");
      assert.equal(second.ran.debit, undefined, "the recorded debit did not run again");
      assert.equal(second.ran.credit, 1);
      assert.deepEqual([yield* balance(db, "alice"), yield* balance(db, "bob")], [90, 110]);
    }).pipe(Effect.provide(Layer.provideMerge(transferLayer(db, second), db.workflowEngine)));
  })));
});

test("a Tenant's outbox starts one execution per message, and a message delivered twice starts one", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-saga-outbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const db = yield* open(dir);
    yield* seed(db);
    const hooks = { ran: {} };
    const alice = db.forTenant("alice");
    yield* alice.documents.write({ operations: [{ _tag: "Update", collection: "accounts", id: "main", data: { note: "pay bob" } }], emit: [{ topic: "transfers", payload: { amount: 5 }, id: "m1" }] });
    yield* Effect.gen(function* () {
      const consumer = yield* Effect.forkChild(startFromOutbox({
        outbox: alice.outbox, topic: "transfers", workflow: Transfer, interval: "5 millis",
        payloadOf: (message) => ({ id: message.id, amount: message.payload.amount, failAfterDebit: false }),
      }));
      for (let tries = 0; tries < 400 && (yield* balance(db, "bob")) !== 105; tries++) yield* Effect.sleep("5 millis");
      // The same message id again (a redelivery): the execution exists, so nothing moves twice.
      yield* Transfer.execute({ id: "m1", amount: 5, failAfterDebit: false });
      assert.deepEqual([yield* balance(db, "alice"), yield* balance(db, "bob")].slice(1), [105]);
      assert.equal((yield* alice.outbox.read({ topic: "transfers" })).messages.some((m) => m.id === "m1"), false, "the handled message was removed");
      yield* Fiber.interrupt(consumer);
    }).pipe(Effect.provide(Layer.provideMerge(transferLayer(db, hooks), db.workflowEngine)));
  })));
});

test("recorded executions are listed the same through HTTP, the SDK and the CLI", async (t) => {
  const { openTemporaryDatabase } = await import("./_database.mjs");
  const { defineDatabaseService } = await import("../dist/db/index.js");
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runProjectsCommand } = await import("../dist/cli/projects.js");
  const opened = await openTemporaryDatabase(t, { crossTenantRefresh: false });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* seed(opened.database);
    yield* Transfer.execute({ id: "listed", amount: 1, failAfterDebit: false })
      .pipe(Effect.provide(Layer.provideMerge(transferLayer(opened.database, { ran: {} }), opened.database.workflowEngine)));
  })));
  const route = defineDatabaseService(opened.api).api.v1.find((entry) => entry.id === "database.workflows.executions");
  const call = async () => (await route.handler({ service: opened.api, params: {}, query: new URLSearchParams(), body: undefined, principal: undefined, headers: {}, request: undefined })).body;
  const fetch = async () => new Response(JSON.stringify(await call()), { status: 200, headers: { "content-type": "application/json" } });
  const http = (await call()).executions;
  const sdk = await createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch }).projects.workflowExecutions("p1");
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
  globalThis.fetch = fetch; console.log = (line) => lines.push(String(line));
  try { await runProjectsCommand(["workflows", "p1", "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  const cli = JSON.parse(lines.join("\n")).executions;
  assert.equal(http.length, 1);
  assert.deepEqual([http[0].workflow, http[0].complete, http[0].activities], ["Transfer", true, 2]);
  assert.deepEqual(sdk, http);
  assert.deepEqual(cli, http);
});
