// Merging a branch back into its source: each side's changes after the branch point, by document identity; what
// only the branch changed is applied, what both changed differently is a conflict with no default winner, settled
// per document by the caller; nothing is written while one is unsettled; a repeated merge applies nothing twice.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/db/index.js";
import { makeMemoryStore } from "../dist/db/engines/memory-kv.js";

const run = (body) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const db = yield* makeDatabase({ partitionMap: partitionMapFor(["s0", "s1"]), crossTenantRefresh: false, openShard: (shard) => makeMemoryStore(shard) });
  return yield* body(db);
})));
const state = (tenant) => Effect.map(tenant.documents.findMany({ collection: "posts", limit: 1000 }), (docs) =>
  Object.fromEntries(docs.map((doc) => [doc.id, doc.data.title]).sort(([a], [b]) => (a < b ? -1 : 1))));

test("only the branch's changes are applied; conflicts write nothing until settled; a second merge applies nothing", () => run((db) => Effect.gen(function* () {
  const main = db.forTenant("main");
  yield* main.documents.createCollection({ name: "posts", columns: ["title"] });
  for (const id of ["a", "b", "c", "d", "e"]) yield* main.documents.insert({ collection: "posts", id, data: { title: id } });
  yield* db.branchTenant("main", "draft");
  const draft = db.forTenant("draft");
  // Branch: edits a, deletes b, adds f, edits c and d (which the source also edits), creates a collection.
  yield* draft.documents.update({ collection: "posts", id: "a", data: { title: "a-branch" } });
  yield* draft.documents.delete({ collection: "posts", id: "b" });
  yield* draft.documents.insert({ collection: "posts", id: "f", data: { title: "f-branch" } });
  yield* draft.documents.update({ collection: "posts", id: "c", data: { title: "c-branch" } });
  yield* draft.documents.update({ collection: "posts", id: "d", data: { title: "same" } });
  yield* draft.documents.createCollection({ name: "notes" });
  yield* draft.documents.insert({ collection: "notes", id: "n1", data: { text: "new" } });
  yield* draft.outbox.emit({ topic: "mail", payload: {}, id: "owed-by-branch" });
  // Source: edits c differently, d to the same state, e on its own.
  yield* main.documents.update({ collection: "posts", id: "c", data: { title: "c-source" } });
  yield* main.documents.update({ collection: "posts", id: "d", data: { title: "same" } });
  yield* main.documents.update({ collection: "posts", id: "e", data: { title: "e-source" } });
  const before = yield* state(main);

  const plan = yield* db.mergeBranch("draft", { dryRun: true });
  assert.equal(plan.into, "main");
  assert.equal(plan.merged, false);
  assert.deepEqual(plan.partitions[0].conflicts.map((c) => [c.kind, c.collection, c.id]), [["document", "posts", "c"]]);
  assert.deepEqual(plan.partitions[0].created, ["notes"]);
  assert.deepEqual(plan.partitions[0].unmerged, ["zv.outbox"], "outbox messages are reported, not dropped silently");
  assert.deepEqual(yield* state(main), before, "a dry run writes nothing");

  const blocked = yield* db.mergeBranch("draft");
  assert.deepEqual([blocked.merged, blocked.conflictCount], [false, 1]);
  assert.deepEqual(yield* state(main), before, "an unsettled conflict writes nothing");

  const merged = yield* db.mergeBranch("draft", { resolve: [{ collection: "posts", id: "c", keep: "branch" }] });
  assert.deepEqual([merged.merged, merged.writes, merged.deletes], [true, 4, 1]);
  assert.deepEqual(yield* state(main), { a: "a-branch", c: "c-branch", d: "same", e: "e-source", f: "f-branch" });
  assert.deepEqual((yield* main.documents.findMany({ collection: "notes" })).map((doc) => doc.id), ["n1"]);
  assert.equal((yield* main.documents.findMany({ collection: "posts", where: [{ path: "title", value: "f-branch" }] })).length, 1, "merged documents are indexed under the source's columns");

  const again = yield* db.mergeBranch("draft", { resolve: [{ collection: "posts", id: "c", keep: "branch" }] });
  assert.deepEqual([again.merged, again.writes, again.deletes, again.conflictCount], [true, 0, 0, 0], "everything already carries the branch's state");
  assert.ok((yield* main.documents.findById({ collection: "posts", id: "a" })).version === 2, "nothing was written twice");

  // Keeping the source's side leaves the source's document.
  yield* draft.documents.update({ collection: "posts", id: "e", data: { title: "e-branch" } });
  const kept = yield* db.mergeBranch("draft", { resolve: [{ collection: "posts", id: "c", keep: "branch" }, { collection: "posts", id: "e", keep: "source" }] });
  assert.equal(kept.merged, true);
  assert.equal((yield* main.documents.findById({ collection: "posts", id: "e" })).data.title, "e-source");
})));

test("a merge refuses what is not a branch, the wrong source, and a source whose constraints refuse the branch's documents", () => run((db) => Effect.gen(function* () {
  const main = db.forTenant("main");
  yield* main.documents.createCollection({ name: "posts", indexes: [{ name: "by_title", fields: [{ path: "title" }], unique: true }] });
  yield* main.documents.insert({ collection: "posts", id: "a", data: { title: "a" } });
  for (const [branch, options, reason] of [["main", {}, /not branched from anything/], ["nobody", {}, /holds nothing/], ["zv.global", {}, /not a Tenant/]]) {
    const refused = yield* Effect.flip(db.mergeBranch(branch, options));
    assert.equal(refused._tag, "BranchNotMergeable");
    assert.match(refused.reason, reason);
  }
  yield* db.branchTenant("main", "draft");
  assert.match((yield* Effect.flip(db.mergeBranch("draft", { into: "other" }))).reason, /branched from "main"/);
  yield* db.forTenant("draft").documents.insert({ collection: "posts", id: "b", data: { title: "taken" } });
  yield* main.documents.insert({ collection: "posts", id: "c", data: { title: "taken" } });
  const refused = yield* Effect.flip(db.mergeBranch("draft"));
  assert.equal(refused._tag, "UniqueViolation", "the source's own constraints hold for merged documents");
  assert.equal((yield* main.documents.findById({ collection: "posts", id: "b" })), undefined, "the refused batch wrote nothing");
})));

test("a divided branch is planned part by part before any part is written", () => run((db) => Effect.gen(function* () {
  yield* db.topology.subdivision.subdivide("whale", ["a", "b"]);
  for (const part of ["a", "b"]) {
    yield* db.forPart("whale", part).documents.createCollection({ name: "posts" });
    yield* db.forPart("whale", part).documents.insert({ collection: "posts", id: `${part}1`, data: { title: "base" } });
  }
  yield* db.branchTenant("whale", "whale-draft");
  yield* db.forPart("whale-draft", "a").documents.update({ collection: "posts", id: "a1", data: { title: "branch" } });
  yield* db.forPart("whale-draft", "b").documents.update({ collection: "posts", id: "b1", data: { title: "branch" } });
  yield* db.forPart("whale", "b").documents.update({ collection: "posts", id: "b1", data: { title: "source" } });
  const blocked = yield* db.mergeBranch("whale-draft");
  assert.deepEqual([blocked.merged, blocked.conflictCount], [false, 1]);
  assert.equal((yield* db.forPart("whale", "a").documents.findById({ collection: "posts", id: "a1" })).data.title, "base", "part a waits for part b's conflict");
  const merged = yield* db.mergeBranch("whale-draft", { resolve: [{ collection: "posts", id: "b1", keep: "source" }] });
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.partitions.map((entry) => [entry.part, entry.writes]), [["a", 1], ["b", 0]]);
  assert.equal((yield* db.forPart("whale", "a").documents.findById({ collection: "posts", id: "a1" })).data.title, "branch");
})));
