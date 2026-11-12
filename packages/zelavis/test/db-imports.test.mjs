// Importing documents from another system's export: a dry run that finds every problem before anything is written,
// bounded idempotent batches that a repeated or resumed run never writes twice, and a verification that compares
// what is stored with the source by content and checksum.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";

const run = (body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0"]), crossTenantRefresh: false, openShard: (shard) => makeMemoryStore(shard) });
  return yield* body(db.forTenant("acme"));
})));

const csv = [
  "id,name,price,stock,active,meta",
  'p1,"Lamp, brass",12.5,3,true,"{""tags"":[""home""]}"',
  'p2,"Say ""hi""",4,0,false,',
  "p3,Plain,7,12,1,",
].join("\r\n");
const types = { price: "number", stock: "integer", active: "boolean", meta: "json" };

test("a CSV export is planned, written and verified exactly", () => run((acme) => Effect.gen(function* () {
  yield* acme.documents.createCollection({ name: "products" });
  const plan = yield* acme.imports.plan({ collection: "products", format: "csv", text: csv, types });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.equal(plan.rows, 3);
  assert.deepEqual(plan.fields, ["active", "meta", "name", "price", "stock"]);
  assert.match(plan.checksum, /^[0-9a-f]{64}$/);
  assert.equal((yield* acme.documents.findMany({ collection: "products" })).length, 0, "a plan writes nothing");

  const written = yield* acme.imports.run({ collection: "products", format: "csv", text: csv, types, importId: "shop-1" });
  assert.deepEqual([written.written, written.next, written.checksum], [3, undefined, plan.checksum]);
  const lamp = yield* acme.documents.findById({ collection: "products", id: "p1" });
  assert.deepEqual(lamp.data, { name: "Lamp, brass", price: 12.5, stock: 3, active: true, meta: { tags: ["home"] } });
  assert.deepEqual((yield* acme.documents.findById({ collection: "products", id: "p2" })).data, { name: 'Say "hi"', price: 4, stock: 0, active: false }, "an empty cell is absent");

  const verified = yield* acme.imports.verify({ collection: "products", format: "csv", text: csv, types });
  assert.deepEqual([verified.ok, verified.matched, verified.sourceChecksum === verified.storedChecksum], [true, 3, true]);
  yield* acme.documents.update({ collection: "products", id: "p2", data: { price: 5 } });
  yield* acme.documents.delete({ collection: "products", id: "p3" });
  const drifted = yield* acme.imports.verify({ collection: "products", format: "csv", text: csv, types });
  assert.deepEqual([drifted.ok, drifted.matched, drifted.different, drifted.missing], [false, 1, ["p2"], ["p3"]]);
})));

test("a plan finds every problem, and a run refuses a source with any", () => run((acme) => Effect.gen(function* () {
  yield* acme.documents.createCollection({ name: "people" });
  yield* acme.schemas.save({ collection: "people", version: 1, fields: [{ name: "age", field: { _tag: "IntegerField", label: "Age", required: true } }] });
  yield* acme.documents.insert({ collection: "people", id: "held", data: { age: 1 } });
  const text = [
    JSON.stringify({ id: "a", age: 30 }),
    "not json",
    JSON.stringify({ age: 2 }),
    JSON.stringify({ id: "a", age: 31 }),
    JSON.stringify({ id: "b", age: "old" }),
    JSON.stringify({ id: "held", age: 5 }),
    JSON.stringify([1]),
  ].join("\n");
  const plan = yield* acme.imports.plan({ collection: "people", format: "ndjson", text });
  assert.equal(plan.valid, false);
  assert.deepEqual(plan.problems.map((problem) => problem.row), [2, 3, 4, 7, 5, 6]);
  assert.match(plan.problems.find((problem) => problem.id === "held").reason, /held already/);
  assert.equal(plan.problemCount, 6);
  const refused = yield* Effect.flip(acme.imports.run({ collection: "people", format: "ndjson", text, importId: "people-1" }));
  assert.equal(refused._tag, "InvalidImport");
  assert.match(refused.reason, /6 problems/);
  assert.equal((yield* acme.documents.findMany({ collection: "people" })).length, 1, "nothing was written");
  // Upsert accepts the held id; the rest still has to be fixed.
  const upsert = yield* acme.imports.plan({ collection: "people", format: "json", text: JSON.stringify([{ id: "held", age: 5 }]), mode: "upsert" });
  assert.equal(upsert.valid, true);
  for (const [source, reason] of [
    [{ collection: "nope", format: "json", text: "[]" }, /no collection "nope"/],
    [{ collection: "people", format: "xml", text: "" }, /csv, ndjson or json/],
    [{ collection: "people", format: "json", text: "{}" }, /array of objects/],
    [{ collection: "people", format: "csv", text: "id\n\"open" }, /inside a quoted field/],
    [{ collection: "people", format: "csv", text: "id,id\n1,2" }, /names a column twice/],
    [{ collection: "people", format: "csv", text: "id,n\n1,2", types: { n: "decimal" } }, /use string, number/],
  ]) {
    const error = yield* Effect.flip(acme.imports.plan(source));
    assert.equal(error._tag, "InvalidImport");
    assert.match(error.reason, reason);
  }
})));

test("a large import runs in bounded calls, and a repeated or resumed run writes nothing twice", () => run((acme) => Effect.gen(function* () {
  yield* acme.documents.createCollection({ name: "rows" });
  const rows = Array.from({ length: 1200 }, (_, n) => ({ id: `r${n}`, n }));
  const source = { collection: "rows", format: "json", text: JSON.stringify(rows), importId: "bulk" };
  const first = yield* acme.imports.run({ ...source, limit: 500 });
  assert.deepEqual([first.written, first.next], [500, 500]);
  // The same first call again: its batches are already written, so nothing changes.
  const again = yield* acme.imports.run({ ...source, limit: 500 });
  assert.equal(again.next, 500);
  assert.ok((yield* acme.documents.findMany({ collection: "rows", limit: 2000 })).every((doc) => doc.version === 1), "no document was written twice");
  assert.equal((yield* Effect.flip(acme.imports.run({ ...source, offset: 123 })))._tag, "InvalidImport", "an offset is a batch boundary");
  let at = first.next;
  while (at !== undefined) at = (yield* acme.imports.run({ ...source, offset: at, limit: 500 })).next;
  assert.equal((yield* acme.documents.count({ collection: "rows" })), 1200);
  assert.equal((yield* acme.imports.verify(source)).ok, true);
  // A different source under the same import id is a different import: an insert refuses ids already held.
  const changed = { ...source, text: JSON.stringify(rows.map((row) => ({ ...row, n: row.n + 1 }))) };
  assert.match((yield* Effect.flip(acme.imports.run(changed))).reason, /problems/);
})));
