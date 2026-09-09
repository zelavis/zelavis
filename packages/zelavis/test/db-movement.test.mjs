import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber } from "effect";
import { makeDatabase, partitionMapFor, shardFor } from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const withDatabase = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = new Map();
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0", "s1"]),
        openShard: (shard) =>
          Effect.tap(makeNodeSqliteStore(shard, dir), (store) =>
            Effect.sync(() => stores.set(shard, store))),
      });
      return yield* body(db, stores);
    })),
  );
};

/**
 * A map placing every range on one shard.
 *
 * The bluntest possible change, and the one that guarantees every tenant has to
 * move rather than leaving the test to hope some of them did.
 */
const allOn = (shard, version) => ({
  version,
  virtualRanges: 256,
  placements: [{ from: 0, to: 256, shard }],
});

const seed = (db, tenants) =>
  Effect.gen(function* () {
    for (const tenant of tenants) {
      const docs = db.forTenant(tenant).documents;
      yield* docs.createCollection({ name: "posts" });
      for (let i = 1; i <= 3; i++) {
        yield* docs.insert({
          collection: "posts",
          id: `p${i}`,
          data: { title: `${tenant}-${i}`, state: i === 2 ? "draft" : "live" },
        });
      }
      yield* docs.update({ collection: "posts", id: "p1", data: { title: `${tenant}-edited` } });
    }
  });

const snapshot = (db, tenant) =>
  Effect.gen(function* () {
    const docs = db.forTenant(tenant).documents;
    const found = yield* docs.findMany({ collection: "posts" });
    return {
      collections: (yield* docs.listCollections).map((c) => c.name),
      docs: found
        .map((d) => `${d.id}:${d.data.title}:v${d.version}`)
        .sort(),
      live: (yield* docs.findMany({ collection: "posts", where: [{ path: "state", value: "live" }] }))
        .map((d) => d.id).sort(),
    };
  });

test("a map that would strand records is still refused on its own", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db, ["acme", "bravo", "cosmo", "delta"]);
      const target = allOn("s1", 2);

      const planned = yield* db.movement.plan(target);
      assert.ok(planned.length > 0, "there are ranges to move");
      assert.ok(planned.some((move) => move.tenants.length > 0), "and tenants standing on them");

      // Unchanged behaviour: routing carries no data, so moving a range out
      // from under records would point every read at a shard that has none.
      const refused = yield* Effect.flip(db.topology.update(target));
      assert.equal(refused._tag, "RangeNotEmpty");
      assert.equal(db.partitionMap.version, 1, "and the map in force did not change");
    }),
  );
});

test("a rebalance moves the records, then the routing", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);

      const before = {};
      for (const tenant of tenants) before[tenant] = yield* snapshot(db, tenant);
      const moved = tenants.filter((tenant) => db.shardOf(tenant) !== "s1");
      assert.ok(moved.length > 0, "some tenants started somewhere other than the target");

      const result = yield* db.movement.rebalance(allOn("s1", 2));

      assert.equal(result.map.version, 2);
      assert.deepEqual(result.moves.map((move) => move.tenant).sort(), moved.sort());
      for (const move of result.moves) {
        assert.equal(move.to, "s1");
        assert.ok(move.copied > 0, `${move.tenant} copied nothing`);
        assert.ok(move.removed > 0, `${move.tenant} left its records behind`);
        assert.equal(move.resumed, false);
      }

      // Routing followed the records rather than the other way round.
      for (const tenant of tenants) {
        assert.equal(db.shardOf(tenant), "s1");
        assert.deepEqual(yield* snapshot(db, tenant), before[tenant],
          `${tenant} does not read the same after the move`);
      }

      assert.deepEqual(yield* db.movement.pending, [], "nothing was left half-done");
    }),
  );
});

test("the shard a tenant left stops holding it, and stops claiming it", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const from = tenants.find((tenant) => db.shardOf(tenant) === "s0");
      assert.ok(from !== undefined, "a tenant to move off s0");

      yield* db.movement.rebalance(allOn("s1", 2));

      // Not just unreachable: gone. A shard that kept the records would go on
      // growing, and one that kept the occupancy marker would tell the next
      // placement decision it is still occupied.
      const left = yield* stores.get("s0").liveRecords;
      const owners = left.map((record) => record.identity.namespace);
      assert.ok(!owners.some((ns) => ns.includes(from)),
        `s0 still holds records for ${from}: ${owners.join(", ")}`);

      const targets = yield* db.scatter.targets();
      assert.ok(targets.every((target) => target.shard === "s1"),
        "every tenant is reported on the shard that now holds it");
      assert.deepEqual(targets.map((target) => target.tenant).sort(), tenants);
    }),
  );
});

test("a fenced tenant refuses every kind of write and none of the reads", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      yield* seed(db, ["acme", "bravo", "cosmo", "delta"]);
      const tenant = ["acme", "bravo", "cosmo", "delta"].find((t2) => db.shardOf(t2) === "s0");

      // Stand the tenant behind the fence by hand. A real move only fences for
      // the last catch-up, which is too short to catch in the act, so the state
      // is set up rather than raced for.
      const source = stores.get("s0");
      const enc = new TextEncoder();
      const seq = yield* source.nextSeq;
      yield* source.transact((txn) =>
        txn.put(seq, enc.encode(JSON.stringify({ from: "s0", to: "s1" })),
          { terms: [], columns: [], measures: [], edges: [] },
          { namespace: "zv.moving", key: tenant }));

      const docs = db.forTenant(tenant).documents;
      const refused = yield* Effect.flip(
        docs.insert({ collection: "posts", id: "p9", data: { title: "late" } }));
      assert.equal(refused._tag, "TenantMoving");
      assert.equal(refused.tenant, tenant);
      assert.equal(refused.to, "s1");

      // Every write, not just inserts: an update or a delete landing on the
      // shard being left would be just as lost.
      assert.equal((yield* Effect.flip(
        docs.update({ collection: "posts", id: "p1", data: { title: "late" } })))._tag,
        "TenantMoving");
      assert.equal((yield* Effect.flip(
        docs.delete({ collection: "posts", id: "p1" })))._tag, "TenantMoving");
      assert.equal((yield* Effect.flip(docs.createCollection({ name: "other" })))._tag,
        "TenantMoving");

      // Reads are untouched. The source still holds the data and nothing is
      // changing it, so taking the tenant offline for reading would buy nothing.
      const found = yield* docs.findMany({ collection: "posts" });
      assert.equal(found.length, 3);

      // A tenant that is not moving is not affected by one that is.
      const other = ["acme", "bravo", "cosmo", "delta"].find((t2) => t2 !== tenant);
      yield* db.forTenant(other).documents.insert({
        collection: "posts", id: "p9", data: { title: "fine" },
      });
    }),
  );
});

test("an interrupted move is resumed rather than repaired", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Start a move and stop after the copy, which is the state a crash
      // between copying and routing leaves behind.
      const enc = new TextEncoder();
      const topologyStore = stores.get("zv.topology");
      const record = {
        tenant, from: "s0", to: "s1", phase: "copying",
        startedAt: new Date().toISOString(), map: allOn("s1", 2),
      };
      const fenceSeq = yield* stores.get("s0").nextSeq;
      yield* stores.get("s0").transact((txn) =>
        txn.put(fenceSeq, enc.encode(JSON.stringify({ from: "s0", to: "s1" })),
          { terms: [], columns: [], measures: [], edges: [] },
          { namespace: "zv.moving", key: tenant }));
      const moveSeq = yield* topologyStore.nextSeq;
      yield* topologyStore.transact((txn) =>
        txn.put(moveSeq, enc.encode(JSON.stringify(record)),
          { terms: [], columns: [["zv.move", " move"]], measures: [], edges: [] },
          { namespace: "zv.move", key: tenant }));

      const outstanding = yield* db.movement.pending;
      assert.equal(outstanding.length, 1);
      assert.equal(outstanding[0].phase, "copying");

      // A map change on top of an unfinished move would fence a tenant twice
      // and route it once, so it is refused until the move is settled.
      const blocked = yield* Effect.flip(db.movement.rebalance(allOn("s1", 3)));
      assert.equal(blocked._tag, "PartitionMapInvalid");
      assert.match(blocked.reason, /have not finished/);

      const finished = yield* db.movement.resume;
      assert.equal(finished.length, 1);
      // A resume never takes the unfenced path: it has no record of the
      // identifier mapping or the log position the interrupted copy reached, so
      // it fences first and copies again from the start.
      assert.equal(finished[0].resumed, true);
      assert.equal(finished[0].rounds, 0, "a resumed copy does not chase a moving target");
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* snapshot(db, tenant), before);
      assert.deepEqual(yield* db.movement.pending, []);

      // And the fence came off with it.
      yield* db.forTenant(tenant).documents.insert({
        collection: "posts", id: "p9", data: { title: "after" },
      });
    }),
  );
});

test("a copy interrupted halfway is not restored alongside its own wreckage", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Put half a copy on the target, as an attempt that died mid-restore
      // would. Resuming has to discard it: replaying the rest alongside would
      // leave a tenant that is partly the old copy and looks whole.
      const partial = yield* db.forTenant(tenant).backups.exportTenant;
      const target = stores.get("s1");
      const enc = new TextEncoder();
      for (const event of partial.events.slice(0, 2)) {
        const seq = yield* target.nextSeq;
        yield* target.transact((txn) =>
          txn.put(seq, new Uint8Array(Buffer.from(event.body, "base64")),
            event.manifest, event.identity));
      }
      void enc;

      const result = yield* db.movement.rebalance(allOn("s1", 2));
      const move = result.moves.find((m) => m.tenant === tenant);
      assert.ok(move !== undefined);

      assert.deepEqual(yield* snapshot(db, tenant), before,
        "the tenant reads as it did, not as a mixture of two copies");
    }),
  );
});

test("a rebalance with nothing standing in the way is an ordinary map change", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const result = yield* db.movement.rebalance(allOn("s1", 2));
      assert.deepEqual(result.moves, [], "no tenants, so nothing to relocate");
      assert.equal(result.map.version, 2);
      assert.equal(shardFor(db.partitionMap, "anything"), "s1");
    }),
  );
});

test("a move whose routing already landed is finished, not copied again", async (t) => {
  await withDatabase(t, (db, stores) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");
      const before = yield* snapshot(db, tenant);

      // Take a real move all the way to routed, then put the record back as a
      // process that died during cleanup would have left it: routing moved,
      // source not yet emptied.
      const enc = new TextEncoder();
      const topologyStore = stores.get("zv.topology");
      const writeMove = (record) =>
        Effect.gen(function* () {
          const existing = yield* topologyStore.lookup("zv.move", tenant);
          const seq = existing ?? (yield* topologyStore.nextSeq);
          yield* topologyStore.transact((txn) =>
            txn.put(seq, enc.encode(JSON.stringify(record)),
              { terms: [], columns: [["zv.move", " move"]], measures: [], edges: [] },
              { namespace: "zv.move", key: tenant }));
        });

      yield* db.movement.rebalance(allOn("s1", 2));
      assert.equal(db.shardOf(tenant), "s1");

      // Re-open the wound: the cleanup is undone by hand so the resume has a
      // routed move to finish.
      yield* writeMove({
        tenant, from: "s0", to: "s1", phase: "routed",
        startedAt: new Date().toISOString(), map: allOn("s1", 2),
      });

      const finished = yield* db.movement.resume;
      assert.equal(finished.length, 1);
      assert.equal(finished[0].resumed, true, "it was picked up rather than started");
      assert.equal(finished[0].copied, 0, "a routed move does not copy anything again");

      // Routing did not move a second time, and the tenant still reads the same.
      assert.equal(db.partitionMap.version, 2, "the map was applied once, not twice");
      assert.equal(db.shardOf(tenant), "s1");
      assert.deepEqual(yield* snapshot(db, tenant), before);
      assert.deepEqual(yield* db.movement.pending, []);
    }),
  );
});

test("a tenant can be written while it is being moved", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      const tenants = ["acme", "bravo", "cosmo", "delta"];
      yield* seed(db, tenants);
      const tenant = tenants.find((t2) => db.shardOf(t2) === "s0");

      // Enough that the copy is not over before the first concurrent write
      // gets a turn.
      const docs = () => db.forTenant(tenant).documents;
      for (let i = 0; i < 200; i++) {
        yield* docs().insert({ collection: "posts", id: `bulk${i}`, data: { title: `b${i}` } });
      }

      const accepted = [];
      let refused = 0;

      // The move runs while writes keep arriving. Before this change every one
      // of them would have been refused: the fence went on before the copy and
      // stayed on until routing moved.
      const moving = yield* Effect.forkChild(db.movement.rebalance(allOn("s1", 2)));

      for (let i = 0; i < 400; i++) {
        const outcome = yield* Effect.result(
          docs().insert({ collection: "posts", id: `live${i}`, data: { title: `w${i}` } }));
        if (outcome._tag === "Success") accepted.push(`live${i}`);
        else {
          assert.equal(outcome.failure._tag, "TenantMoving");
          refused += 1;
        }
      }

      const result = yield* Fiber.join(moving);
      const move = result.moves.find((m) => m.tenant === tenant);
      assert.ok(move !== undefined, "the tenant moved");

      assert.ok(accepted.length > 0,
        "every write was refused, so the move still takes the tenant offline");

      // The ones that were accepted are on the shard the tenant now lives on —
      // which is the whole claim: writes taken during the copy are not lost
      // behind it.
      const found = yield* docs().findMany({ collection: "posts" });
      const ids = new Set(found.map((doc) => doc.id));
      const missing = accepted.filter((id) => !ids.has(id));
      assert.deepEqual(missing, [],
        `${missing.length} of ${accepted.length} writes accepted during the move were lost`);

      assert.equal(db.shardOf(tenant), "s1");
      assert.ok(move.settled <= move.copied,
        "the fenced part of the move is smaller than the unfenced part");
      t.diagnostic(
        `copied ${move.copied}, caught up ${move.caughtUp} over ${move.rounds} rounds, ` +
        `settled ${move.settled} behind the fence; ${accepted.length} writes accepted, ` +
        `${refused} refused`);
    }),
  );
});
