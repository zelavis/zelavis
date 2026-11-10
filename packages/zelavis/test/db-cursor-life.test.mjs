// An event cursor belongs to one life of one partition. A Tenant removed and written again starts a new log whose
// positions begin over, so a cursor kept from before must be refused rather than read as a place in the new log:
// read as one, it skips every event of the new life up to its old position and nobody hears about it. These tests
// hold the store to that across removal and recreation, and to what must keep working: a branch continuing its
// source's cursor up to the branch point, a move keeping the life, and position 0 meaning the start of any life; and
// they hold a follower, a branch merge and the change feed's HTTP, SDK and CLI forms to what they do with the refusal.
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit, Stream } from "effect";
import { defineDatabaseService, levelFollower, makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { makeMemoryStore, memoryKvEngine } from "../dist/db/engines/memory-kv.js";
import { openShardOverKv } from "../dist/db/kv-store.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runDataCommand } from "../dist/cli/data.js";
import { openTemporaryDatabase } from "./_database.mjs";

const map = partitionMapFor(["s0", "s1"]);

const withDatabase = (body) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const shards = new Map();
    const db = yield* makeDatabase({
      partitionMap: map,
      crossTenantRefresh: false,
      openShard: (shard) => Effect.tap(openShardOverKv(shard, memoryKvEngine()), (store) => Effect.sync(() => shards.set(shard, store))),
    });
    return yield* body(db, shards);
  })));

const across = (() => {
  const names = Array.from({ length: 64 }, (_, at) => `t${at}`);
  const first = names[0];
  const other = names.find((name) => shardFor(map, name) !== shardFor(map, first));
  return { first, other };
})();

const write = (tenant, ids) => Effect.forEach(ids, (id) => tenant.documents.insert({ collection: "posts", id, data: { title: id } }));
const squashed = (exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined);

test("a cursor from before a Tenant was removed and written again is refused, not read as a place in the new log", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["a", "b", "c", "d", "e", "f"]);
    const old = (yield* tenant.events.read({ limit: 100 })).cursor;
    assert.ok(old !== undefined);

    yield* db.dropTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["x"]);

    const exit = yield* Effect.exit(tenant.events.read({ after: old, limit: 100 }));
    const error = squashed(exit);
    assert.equal(error?._tag, "CursorFromAnotherLife", `the old cursor was read as ${JSON.stringify(Exit.isSuccess(exit) ? exit.value.events.map((event) => event.documentId) : error)}`);
    assert.equal(error.partition, across.first);

    // Once the new log has passed the old position, the old cursor would have resumed somewhere in the middle of it.
    yield* write(tenant, ["y", "z", "w", "v", "u", "t", "s"]);
    assert.equal(squashed(yield* Effect.exit(tenant.events.read({ after: old, limit: 100 })))?._tag, "CursorFromAnotherLife");

    const fresh = yield* tenant.events.read({ limit: 100 });
    assert.deepEqual(fresh.events.filter((event) => event.documentId !== undefined).map((event) => event.documentId),
      ["x", "y", "z", "w", "v", "u", "t", "s"], "a reader starting over sees the whole new life");
    assert.deepEqual((yield* tenant.events.read({ after: fresh.cursor, limit: 100 })).events, [], "a cursor of this life carries on");
  })));

const store = (db, shards, tenant) => shards.get(db.shardOf(tenant)).partition(tenant);

test("a Tenant removed and not written again refuses an old cursor rather than answering that nothing is new", () =>
  withDatabase((db) => Effect.gen(function* () {
    const tenant = db.forTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["a"]);
    const old = (yield* tenant.events.read({ limit: 100 })).cursor;
    yield* db.dropTenant(across.first);
    assert.equal(squashed(yield* Effect.exit(tenant.events.read({ after: old, limit: 100 })))?._tag, "CursorFromAnotherLife");
  })));

test("position 0 is the start of every life: of an empty partition, and of one removed and written again", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(across.first);
    const empty = yield* store(db, shards, across.first).cursorAt(0);
    assert.equal((yield* store(db, shards, across.first).stats).incarnation, undefined, "nothing was written yet");
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["a", "b"]);
    const start = yield* store(db, shards, across.first).cursorAt(0);
    const all = (page) => page.events.filter((event) => event.documentId !== undefined).map((event) => event.documentId);
    assert.deepEqual(all(yield* tenant.events.read({ after: empty, limit: 100 })), ["a", "b"], "a start taken before the first write reads the first life");

    yield* db.dropTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["x"]);
    assert.deepEqual(all(yield* tenant.events.read({ after: start, limit: 100 })), ["x"], "the first life's start reads the second from its start");
    assert.deepEqual(all(yield* tenant.events.read({ after: empty, limit: 100 })), ["x"]);
  })));

test("a move keeps the life: a cursor taken before it carries on after it, on the new shard", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const tenant = db.forTenant(across.first);
    yield* tenant.documents.createCollection({ name: "posts" });
    yield* write(tenant, ["a", "b"]);
    const before = yield* tenant.events.read({ limit: 100 });
    const life = (yield* store(db, shards, across.first).stats).incarnation;
    const from = db.shardOf(across.first);
    const to = from === "s0" ? "s1" : "s0";
    yield* db.movement.rebalance({ version: 2, virtualRanges: 256, placements: [{ from: 0, to: 256, shard: to }] });
    assert.equal(db.shardOf(across.first), to);
    assert.equal((yield* store(db, shards, across.first).stats).incarnation, life, "the copy is the same life");

    yield* write(tenant, ["c"]);
    assert.deepEqual((yield* tenant.events.read({ after: before.cursor, limit: 100 })).events.map((event) => event.documentId), ["c"]);
  })));

test("a branch carries on a cursor of the life it was branched from up to the branch point, and refuses one of the source's next life", () =>
  withDatabase((db, shards) => Effect.gen(function* () {
    const source = db.forTenant(across.first);
    yield* source.documents.createCollection({ name: "posts" });
    yield* write(source, ["a", "b", "c"]);
    const early = (yield* source.events.read({ limit: 2 })).cursor;
    yield* db.branchTenant(across.first, across.other);
    const branch = db.forTenant(across.other);
    const ids = (page) => page.events.filter((event) => event.documentId !== undefined).map((event) => event.documentId);
    const fromEarly = ids(yield* branch.events.read({ after: early, limit: 100 }));
    assert.ok(fromEarly.length > 0 && fromEarly.at(-1) === "c", "the source's cursor names the same place in the branch");

    // The source starts a new life whose log reaches past the branch point, so its cursors name positions the
    // branch shares with the first life only.
    yield* db.dropTenant(across.first);
    yield* source.documents.createCollection({ name: "posts" });
    yield* write(source, ["x", "y", "z", "w", "v"]);
    const reborn = (yield* source.events.read({ limit: 2 })).cursor;
    const life = (yield* store(db, shards, across.first).stats).incarnation;
    const lineage = (yield* store(db, shards, across.other).stats).lineage;
    assert.notEqual(lineage[0].incarnation, life, "the lineage names the life the branch was taken from");
    assert.equal(squashed(yield* Effect.exit(branch.events.read({ after: reborn, limit: 100 })))?._tag, "CursorFromAnotherLife");
    assert.deepEqual(ids(yield* branch.events.read({ after: early, limit: 100 })), fromEarly, "the first life's cursor still carries on");

    // Nor is the branch merged into a source that is not what it was branched from.
    const refused = squashed(yield* Effect.exit(db.mergeBranch(across.other)));
    assert.equal(refused?._tag, "BranchNotMergeable");
    assert.match(refused.reason, /removed and written again/);
  })));

test("a follower whose leader was removed and written again is copied afresh rather than carried on", () =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const enc = new TextEncoder();
    const manifest = { terms: [], columns: [], measures: [], edges: [] };
    const put = (leader, seq, body) => leader.transact((txn) => txn.put(seq, enc.encode(body), manifest, { namespace: "doc/x", key: `k${seq}` }));
    const leaderShard = yield* makeMemoryStore("one");
    const shard = yield* makeMemoryStore("two");
    const leader = leaderShard.partition("acme");
    for (let seq = 1; seq <= 3; seq++) yield* put(leader, seq, `first-${seq}`);
    assert.equal((yield* levelFollower(leader, { shard, partition: "acme" })).seed, "empty");
    assert.equal((yield* shard.partition("acme").stats).incarnation, (yield* leader.stats).incarnation, "a copy is the leader's life");

    yield* leaderShard.drop("acme");
    for (let seq = 1; seq <= 6; seq++) yield* put(leader, seq, `second-${seq}`);
    const pass = yield* levelFollower(leader, { shard, partition: "acme" });
    assert.equal(pass.seed, "recreated");
    const bodies = (store) => Effect.map(Stream.runCollect(store.records), (records) =>
      [...records].map(({ record }) => new TextDecoder().decode(record.body)));
    assert.deepEqual(yield* bodies(shard.partition("acme")), yield* bodies(leader));
    assert.equal((yield* shard.partition("acme").stats).incarnation, (yield* leader.stats).incarnation);
  }))));

// The change feed's refusal through every surface: the route, the SDK and the CLI, with the App's own authority.
const app = { id: "app", type: "service", permissions: ["database.read", "database.write", "database.define"], metadata: { tenantId: "acme" } };
const BASE = "http://zv.test/zelavis";
const DATA = "/zelavis/api/v1/runtime/projects/p1/data";
const route = (api) => defineDatabaseService(api).api.v1.find((entry) => entry.id === "database.events.read");
const readChanges = async (api, body) => {
  const response = await route(api).handler({ service: api, params: {}, query: new URLSearchParams(), body, principal: app, headers: {}, request: undefined });
  return { status: response.status ?? 200, body: response.body };
};
const platform = (api) => async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.pathname, `${DATA}/events/read`, `unexpected request ${url.pathname}`);
  const answer = await readChanges(api, JSON.parse(init.body));
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};
const cli = async (api, args) => {
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
  globalThis.fetch = platform(api);
  console.log = (line) => lines.push(String(line));
  try { await runDataCommand([...args, "--project", "p1", "--url", BASE, "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  return JSON.parse(lines.join("\n"));
};

test("the change feed refuses a cursor from another life the same way through HTTP, the SDK and the CLI", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  const acme = api.forTenant("acme");
  await acme.documents.createCollection({ name: "posts" });
  for (const id of ["a", "b", "c", "d"]) await acme.documents.insert({ collection: "posts", id, data: { title: id } });
  const old = (await readChanges(api, { limit: 100 })).body.cursor;
  await api.dropTenant("acme");
  await acme.documents.createCollection({ name: "posts" });
  for (const id of ["x", "y", "z", "w", "v", "u"]) await acme.documents.insert({ collection: "posts", id, data: { title: id } });

  const http = await readChanges(api, { after: old });
  assert.equal(http.status, 409);
  assert.equal(http.body.code, "cursor-from-another-life");
  assert.match(http.body.error, /removed and written again since this cursor was issued/);

  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) }).data("p1");
  const sdk = await client.events.read({ after: old }).then(() => assert.fail("the SDK read an old life's cursor"), (error) => error);
  assert.equal(sdk.status, 409);
  assert.equal(sdk.body.code, "cursor-from-another-life");
  assert.equal(sdk.body.error, http.body.error);

  const refused = await cli(api, ["changes", "--data", JSON.stringify({ after: old })]).then(() => assert.fail("the CLI read an old life's cursor"), (error) => error);
  assert.ok(String(refused.message).includes(http.body.error), `the CLI says ${refused.message}`);

  // Starting over is what the refusal asks for, and it reads the whole new life.
  const fresh = await cli(api, ["changes", "--data", JSON.stringify({ collection: "posts", limit: 100 })]);
  assert.deepEqual(fresh.events.filter((event) => event.documentId !== undefined).map((event) => event.documentId), ["x", "y", "z", "w", "v", "u"]);
});
