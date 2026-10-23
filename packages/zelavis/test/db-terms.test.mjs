// `terms()` lists the words a field still holds a posting for.
//
// A sealed blob cannot be edited, so a word every document has since lost is
// still in its blob, cancelled by one tombstone per document. Listing it would
// offer fuzzy search a candidate that matches nothing, for as long as the blob
// lasts; a word some document still holds, in either tier, stays listed.
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";

const enc = new TextEncoder();
const run = (body) => Effect.runPromise(Effect.scoped(body));
const manifest = (words) => ({ terms: words.map((w) => ["title", w]), columns: [], measures: [], edges: [] });
const put = (store, seq, words) =>
  store.transact((txn) => txn.put(seq, enc.encode("{}"), manifest(words), { namespace: "doc/x", key: `k${seq}` }));
/** A partition on an engine of its own. */
const partition = () => Effect.map(openShardOverKv("s", memoryKvEngine()), (shard) => shard.partition("acme"));

/** Enough documents per word for a seal to put it in a blob. */
const DOCUMENTS = 80;

test("a sealed word every document has lost is not listed; one some document keeps is", () => run(Effect.gen(function* () {
  const store = yield* partition();
  for (let seq = 1; seq <= DOCUMENTS; seq++) yield* put(store, seq, ["gone", "goner", "kept"]);
  const seal = yield* store.sealPostings;
  assert.ok(seal.segments > 0, "the words are sealed into blobs");
  assert.deepEqual(yield* store.terms("title"), ["gone", "goner", "kept"]);

  // Every document loses "gone"; all but the last lose "goner".
  for (let seq = 1; seq <= DOCUMENTS; seq++) yield* put(store, seq, seq === DOCUMENTS ? ["goner", "kept"] : ["kept"]);
  assert.deepEqual(yield* store.terms("title"), ["goner", "kept"]);
  assert.deepEqual(yield* store.terms("title", "go"), ["goner"]);

  // Sealing again settles the tombstones into the blobs; the answer holds.
  yield* store.sealPostings;
  assert.deepEqual(yield* store.terms("title"), ["goner", "kept"]);
})));

test("a sealed word lost everywhere and then written again is listed from the live tier", () => run(Effect.gen(function* () {
  const store = yield* partition();
  for (let seq = 1; seq <= DOCUMENTS; seq++) yield* put(store, seq, ["atlas"]);
  yield* store.sealPostings;
  for (let seq = 1; seq <= DOCUMENTS; seq++) yield* store.transact((txn) => txn.retract(seq));
  assert.deepEqual(yield* store.terms("title"), []);

  yield* put(store, DOCUMENTS + 1, ["atlas"]);
  assert.deepEqual(yield* store.terms("title"), ["atlas"]);
  assert.deepEqual(yield* store.terms("title", "at"), ["atlas"]);
})));

test("a word lost before any seal leaves nothing behind to list", () => run(Effect.gen(function* () {
  const store = yield* partition();
  yield* put(store, 1, ["brief", "lasting"]);
  yield* put(store, 1, ["lasting"]);
  assert.deepEqual(yield* store.terms("title"), ["lasting"]);
})));
