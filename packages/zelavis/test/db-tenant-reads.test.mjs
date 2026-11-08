import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Cause, Effect, Exit } from "effect";
import { openShardOverKv, openShardReaderOverKv } from "../dist/db/kv-store.js";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { StoreError } from "../dist/db/errors.js";
import { makeReadBudget } from "../dist/db/read-budget.js";
import { instrumentedSqliteEngine, newStats } from "./_read-budget-fixture.mjs";
import { buildReadsFixture, readInputs } from "./_tenant-reads-fixture.mjs";
import { GLOBAL_TENANT } from "../dist/db/topology.js";
import { TENANT_READ_OPS, TENANT_READ_MEMBERS, READ_ERROR_TAGS, tenantReadsOver, runTenantRead, isShardTenantRead, isPlainJson, encodeReadExit, decodeReadExit } from "../dist/db/tenant-reads.js";

const expected = ["documents.count", "documents.modalities", "documents.listCollections", "documents.collectionExists", "documents.findById", "documents.findMany", "documents.findPage", "documents.searchStatistics", "documents.withRelated", "documents.traverse", "documents.summarize", "documents.covariance", "documents.histogram", "documents.summarizeBy", "shared.listCollections", "shared.collectionExists", "shared.findById", "shared.findMany", "shared.findPage", "events.read", "aggregates.list", "aggregates.get", "outbox.read"];
const roundtrip = value => JSON.parse(JSON.stringify(value));

test("the table contains exactly the data-only reads", () => assert.deepEqual([...TENANT_READ_OPS].sort(), expected.sort()));
test("the classifier keeps all similarity inputs on the writer", () => {
  for (const op of ["documents.findMany", "documents.findPage", "shared.findMany", "shared.findPage"]) {
    assert.equal(isShardTenantRead(op, { collection: "notes" }), true);
    for (const similar of [undefined, null, { field: "vec", vector: [1, 0], approximate: false }]) {
      assert.equal(isShardTenantRead(op, { collection: "notes", search: "alpha", similar }), false);
    }
  }
  for (const op of TENANT_READ_OPS.filter(name => !["documents.findMany", "documents.findPage", "shared.findMany", "shared.findPage"].includes(name))) {
    assert.equal(isShardTenantRead(op, { similar: null }), true);
  }
});
test("the error registry names every tagged database error", () => {
  const source = readFileSync(new URL("../src/db/errors.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/export class (\w+) extends Schema\.TaggedError/g)].map(m => m[1]).sort(), [...READ_ERROR_TAGS].sort());
});
test("non-JSON values are refused with their path", () => {
  assert.deepEqual(isPlainJson({ where: [{ value: NaN }] }), { ok: false, path: "$.where[0].value" });
  assert.match(encodeReadExit(Exit.succeed({ at: new Date() })).defect.message, /\$\.at/);
  assert.equal(isPlainJson(Array.from({ length: 100_000 }, () => 0)).ok, false);
  assert.equal(isPlainJson({ a: Array.from({ length: 100_000 }, () => undefined) }).ok, false);
});

test("tagged store defects retain their plain cause", () => {
  const body = roundtrip(encodeReadExit(Exit.die(new StoreError({ op: "test", cause: "broken" }))));
  const exit = Effect.runSync(Effect.exit(decodeReadExit("events.read", body)));
  const defect = Cause.squash(exit.cause);
  assert.equal(defect._tag, "StoreError");
  assert.equal(defect.op, "test");
  assert.equal(defect.cause, "broken");
});

const sqliteEngines = (shard) => instrumentedSqliteEngine(newStats());
const engineKinds = [["memory", () => Effect.succeed(memoryKvEngine())], ["sqlite", sqliteEngines]];

for (const [kind, engineFor] of engineKinds) for (const budgeted of [false, true]) {
  test(`listed reads agree with the writer through the codec on ${kind}${budgeted ? ", under a work budget" : ""}`, () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const { db, tenant, docs, engines } = yield* buildReadsFixture(engineFor);
  yield* docs.rebuildVectorIndex({ collection: "notes" });
  assert.equal((yield* docs.getVectorIndex({ collection: "notes" })).size(), 2);
  const budget = budgeted ? makeReadBudget() : undefined;
  const reader = yield* openShardReaderOverKv(db.shardOf("t"), engines.get(db.shardOf("t")), budget === undefined ? undefined : { budget });
  const api = tenantReadsOver(reader.partition("t"), reader.partition(GLOBAL_TENANT), "t");
  for (const op of ["documents.findMany", "documents.findPage", "shared.findMany", "shared.findPage"]) {
    for (const similar of [null, { field: "vec", vector: [1, 0], approximate: false }]) {
      const exit = yield* Effect.exit(runTenantRead(api, op, { collection: "notes", similar }));
      assert.equal(Cause.squash(exit.cause).message, "a similarity read must run on the writer");
      assert.equal(exit.cause.reasons[0]._tag, "Die");
    }
  }
  assert.equal(yield* api.documents.getVectorIndex({ collection: "notes" }), undefined);
  const index = yield* docs.getVectorIndex({ collection: "notes" });
  const [nearest] = index.search([1, 0], 1);
  index.remove(nearest.seq);
  const query = { collection: "notes", similar: { field: "vec", vector: [1, 0], k: 1 } };
  const localVector = yield* docs.findMany(query);
  const remoteVector = yield* api.documents.findMany(query);
  assert.notDeepEqual(localVector.map(doc => doc.id), remoteVector.map(doc => doc.id));
  const pageQuery = { ...query, limit: 1 };
  const localPage = yield* docs.findPage(pageQuery);
  const remotePage = yield* api.documents.findPage(pageQuery);
  assert.notDeepEqual(localPage.documents.map(doc => doc.id), remotePage.documents.map(doc => doc.id));
  yield* docs.rebuildVectorIndex({ collection: "notes" });
  const rows = yield* docs.findMany({ collection: "notes" });
  const { inputs, failures } = readInputs(rows);
  for (const op of TENANT_READ_OPS) for (const input of [inputs[op], ...(failures[op] ?? [])]) {
    const [group, member] = TENANT_READ_MEMBERS[op];
    const localMember = tenant[group][member];
    const local = yield* Effect.exit(typeof localMember === "function" ? localMember(input) : localMember);
    if (input !== inputs[op]) assert.ok(Exit.isFailure(local), `${op}: expected a failure example ${JSON.stringify(input)}`);
    if (input === inputs[op]) assert.ok(Exit.isSuccess(local), `${op}: expected a successful example: ${Exit.isFailure(local) ? String(Cause.squash(local.cause)) : ""}`);
    const result = roundtrip(encodeReadExit(yield* Effect.exit(runTenantRead(api, op, roundtrip(input)))));
    const remote = yield* Effect.exit(decodeReadExit(op, result));
    assert.equal(remote._tag, local._tag, `${op}: exit`);
    if (Exit.isSuccess(local)) assert.deepEqual(remote.value === undefined ? undefined : roundtrip(remote.value), local.value === undefined ? undefined : roundtrip(local.value), op);
    else {
      assert.equal(remote.cause.reasons[0]._tag, local.cause.reasons[0]._tag, `${op}: failure channel`);
      const a = Cause.squash(local.cause), b = Cause.squash(remote.cause);
      assert.equal(b._tag, a._tag, op);
      if (a._tag) assert.deepEqual(roundtrip(b), roundtrip(a), op);
    }
  }
  if (budget !== undefined) assert.ok(budget.used().entries > 0 && budget.used().bytes > 0, "the budgeted reads were counted");
  }))));
}
