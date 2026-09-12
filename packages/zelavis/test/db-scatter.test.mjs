import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  and, edge, equals, makeDatabase, partitionMapFor, term,
  TENANT_COLUMN, TENANT_MARKER, TENANT_NAMESPACE,
} from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";
import { asSeq } from "../dist/db/index.js";

/**
 * Four shards, so tenants really do land in different places rather than all
 * hashing to one and letting a broken fan-out pass.
 */
const withDatabase = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-scatter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0", "s1", "s2", "s3"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      return yield* body(db);
    })),
  );
};

const TENANTS = ["acme", "bravo", "cosmo", "delta", "echo"];

const seed = (db) =>
  Effect.gen(function* () {
    for (const tenant of TENANTS) {
      const docs = db.forTenant(tenant).documents;
      yield* docs.createCollection({ name: "posts" });
      for (let i = 1; i <= 4; i++) {
        yield* docs.insert({
          collection: "posts",
          id: `p${i}`,
          data: { title: `${tenant}-${i}`, state: i % 2 === 0 ? "draft" : "live", rank: i },
        });
      }
    }
  });

test("a scatter names every tenant and the shard it is on", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const targets = yield* db.scatter.targets();
      assert.deepEqual(targets.map((target) => target.tenant), TENANTS);
      for (const { tenant, shard } of targets) {
        assert.equal(shard, db.shardOf(tenant), "a target agrees with the partition map");
      }

      // Asked of the shards themselves, so it stays true without a registry
      // being kept in step.
      assert.ok(new Set(targets.map((target) => target.shard)).size > 1,
        "the tenants are spread across shards, so the fan-out has work to do");

      const narrowed = yield* db.scatter.targets(["acme", "delta"]);
      assert.deepEqual(narrowed.map((target) => target.tenant), ["acme", "delta"]);
    }),
  );
});

test("a document scatter gathers from every tenant and says what it cost", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const result = yield* db.scatter.findMany({
        collection: "posts",
        where: [{ path: "state", value: "live" }],
      });

      assert.equal(result.rows.length, TENANTS.length * 2, "two live posts per tenant");
      assert.deepEqual(
        [...new Set(result.rows.map((row) => row.tenant))],
        TENANTS,
        "every tenant contributed, in a stable order",
      );
      for (const row of result.rows) {
        assert.equal(row.document.data.state, "live");
        assert.equal(row.shard, db.shardOf(row.tenant), "each row says where it came from");
        assert.ok(row.document.data.title.startsWith(row.tenant),
          "no row was attributed to the wrong tenant");
      }

      assert.equal(result.legs.length, TENANTS.length);
      assert.equal(result.legs.reduce((n, leg) => n + leg.rows, 0), result.rows.length);
      assert.ok(result.shards > 1, "the cost is reported in shards actually read");
      assert.equal(result.truncated, false);
    }),
  );
});

test("a scatter reaches only the tenants it was pointed at", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const result = yield* db.scatter.findMany({
        collection: "posts",
        tenants: ["bravo", "echo"],
      });

      assert.deepEqual([...new Set(result.rows.map((row) => row.tenant))], ["bravo", "echo"]);
      assert.equal(result.rows.length, 8);
      assert.equal(result.legs.length, 2, "the untouched tenants were not read at all");
    }),
  );
});

test("limits say they cut something rather than leaving it to be inferred", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const perTenant = yield* db.scatter.findMany({ collection: "posts", perTenantLimit: 2 });
      assert.equal(perTenant.rows.length, 10);
      assert.equal(perTenant.truncated, true, "each tenant had more than two");
      assert.ok(perTenant.legs.every((leg) => leg.truncated && leg.rows === 2));

      // A limit that exactly matches what is there is not a truncation, which
      // is the case a plain count-equals-limit check gets wrong.
      const exact = yield* db.scatter.findMany({ collection: "posts", perTenantLimit: 4 });
      assert.equal(exact.rows.length, 20);
      assert.equal(exact.truncated, false);
      assert.ok(exact.legs.every((leg) => !leg.truncated));

      const global = yield* db.scatter.findMany({ collection: "posts", limit: 6 });
      assert.equal(global.rows.length, 6);
      assert.equal(global.truncated, true);
      // The merged order is by tenant then id, so a global limit takes a
      // defined prefix rather than whichever legs happened to finish first.
      assert.deepEqual(global.rows.map((row) => row.tenant),
        ["acme", "acme", "acme", "acme", "bravo", "bravo"]);
    }),
  );
});

test("a scatter is ordered the same way every time it runs", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const once = yield* db.scatter.findMany({ collection: "posts" });
      const again = yield* db.scatter.findMany({ collection: "posts", concurrency: 1 });
      assert.deepEqual(
        again.rows.map((row) => `${row.tenant}/${row.document.id}`),
        once.rows.map((row) => `${row.tenant}/${row.document.id}`),
        "concurrency does not decide the order the caller sees",
      );
    }),
  );
});

test("a raw scatter names matches by shard and identity, not by bare identifier", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const result = yield* db.scatter.resolve({
        query: equals(TENANT_COLUMN, TENANT_MARKER),
      });

      // Every shard allocates from its own dense space, so the same number can
      // come back from several shards naming different objects. Only the pair
      // is a name.
      const shards = new Set();
      for (const match of result.rows) {
        shards.add(match.shard);
        assert.equal(match.namespace, TENANT_NAMESPACE);
        assert.ok(TENANTS.includes(match.key));
      }
      assert.equal(result.rows.length, TENANTS.length);
      assert.ok(shards.size > 1);

      const pairs = new Set(result.rows.map((match) => `${match.shard}:${match.seq}`));
      assert.equal(pairs.size, result.rows.length, "shard and identifier together are unique");

      // The point of carrying the shard: the bare identifiers really do
      // collide. Without this the test would pass on data where they happened
      // not to, and prove nothing about the naming.
      const bare = new Set(result.rows.map((match) => match.seq));
      assert.ok(bare.size < result.rows.length,
        "the same identifier names different objects on different shards");
    }),
  );
});

test("a query naming a local identifier is refused rather than answered wrongly", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      // An edge is stored against the identifier it points at, and identifiers
      // are partition-local — so this asks about one object on the shard that
      // issued it and about unrelated objects everywhere else. Answering it
      // would return rows that look like matches and are not.
      const refused = yield* Effect.flip(db.scatter.resolve({ query: edge("uses", 3) }));
      assert.equal(refused._tag, "CrossPartitionQuery");
      assert.match(refused.detail, /local to one partition/);
      assert.match(refused.detail, /edge\("uses", 3\)/);

      // Nested inside a conjunction is the same query with more to look at.
      const nested = yield* Effect.flip(db.scatter.resolve({
        query: and(term("kind", "post"), edge("uses", 3)),
      }));
      assert.equal(nested._tag, "CrossPartitionQuery");

      // Against a single shard it means exactly what it says, so it is allowed.
      const single = yield* db.scatter.resolve({
        query: edge("uses", 3),
        shards: [db.shardOf("acme")],
      });
      assert.equal(single.shards, 1);
    }),
  );
});

test("a shard the map does not have is refused, not quietly skipped", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      // Reading the three shards that do exist and staying quiet about the
      // fourth would answer a narrower question than the caller asked, and
      // return it looking exactly like the answer to the one they did.
      const refused = yield* Effect.flip(db.scatter.resolve({
        query: equals(TENANT_COLUMN, TENANT_MARKER),
        shards: ["s0", "typo"],
      }));
      assert.equal(refused._tag, "UnknownShard");
      assert.equal(refused.shard, "typo");
      assert.deepEqual([...refused.known], ["s0", "s1", "s2", "s3"]);

      const named = yield* db.scatter.resolve({
        query: equals(TENANT_COLUMN, TENANT_MARKER),
        shards: ["s0", "s2"],
      });
      assert.equal(named.shards, 2);
      assert.ok(named.rows.every((match) => match.shard === "s0" || match.shard === "s2"));
    }),
  );
});

test("a tenant holding nothing is an empty leg rather than a missing one", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const result = yield* db.scatter.findMany({
        collection: "posts",
        tenants: ["acme", "nobody"],
      });

      assert.equal(result.legs.length, 2, "the empty tenant was still asked");
      const empty = result.legs.find((leg) => leg.tenant === "nobody");
      assert.equal(empty.rows, 0);
      assert.equal(empty.shard, db.shardOf("nobody"), "and it says where it looked");
      assert.equal(result.rows.length, 4);
    }),
  );
});

test("the identifier an edge names really does mean something else next door", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-scatter-edge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const stores = new Map();
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0", "s1"]),
        openShard: (shard) =>
          Effect.tap(makeNodeSqliteStore(shard, dir), (store) =>
            Effect.sync(() => stores.set(shard, store))),
      });

      const enc = new TextEncoder();
      const put = (shard, seq, name, edges) =>
        stores.get(shard).transact((txn) =>
          txn.put(
            asSeq(seq),
            enc.encode(JSON.stringify({ name })),
            { terms: [], columns: [], measures: [], edges },
            { namespace: "doc/x/things", key: name },
          ));

      // Both ends of an edge are dense identifiers, and every shard allocates
      // its own. So seq 3 is "alpha" on one shard and "beta" on the other, and
      // an edge from seq 11 points at a different object on each.
      yield* put("s0", 3, "alpha", []);
      yield* put("s1", 3, "beta", []);
      yield* put("s0", 11, "source-a", [["uses", 3]]);
      yield* put("s1", 11, "source-b", [["uses", 3]]);

      const onS0 = yield* db.scatter.resolve({ query: edge("uses", 11), shards: ["s0"] });
      const onS1 = yield* db.scatter.resolve({ query: edge("uses", 11), shards: ["s1"] });
      assert.deepEqual(onS0.rows.map((match) => match.key), ["alpha"]);
      assert.deepEqual(onS1.rows.map((match) => match.key), ["beta"]);

      // One query, two shards, two unrelated answers — and nothing in the rows
      // themselves shows they came from different questions. That is why the
      // union of them is refused rather than returned.
      const refused = yield* Effect.flip(db.scatter.resolve({ query: edge("uses", 11) }));
      assert.equal(refused._tag, "CrossPartitionQuery");
    })),
  );
});

const key = (row) => `${row.tenant}/${row.document.id}`;
const BY_RANK_DESC = [{ path: "rank", direction: "desc" }];
// Every tenant's rank 4, tenant by tenant, then every rank 3, and so on.
const RANK_DESC = [4, 3, 2, 1].flatMap((rank) => TENANTS.map((tenant) => `${tenant}/p${rank}`));

const walkScatter = (db, input, from) => Effect.gen(function* () {
  const pages = [];
  let after = from;
  for (let i = 0; i < 1000; i++) {
    const page = yield* db.scatter.findPage({ collection: "posts", ...input, ...(after === undefined ? {} : { after }) });
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
  }
  throw new Error("the scatter never ended");
});

test("an ordered scatter merges every tenant's run by value, not tenant by tenant", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      const all = yield* db.scatter.findMany({ collection: "posts", orderBy: BY_RANK_DESC });
      assert.deepEqual(all.rows.map(key), RANK_DESC);

      // The first seven across every tenant, read as at most seven from each.
      const top = yield* db.scatter.findMany({ collection: "posts", orderBy: BY_RANK_DESC, limit: 7 });
      assert.deepEqual(top.rows.map(key), RANK_DESC.slice(0, 7));
      assert.equal(top.truncated, true);
      const narrow = yield* db.scatter.findMany({ collection: "posts", orderBy: BY_RANK_DESC, limit: 2 });
      assert.deepEqual(narrow.rows.map(key), ["acme/p4", "bravo/p4"]);
      assert.ok(narrow.legs.every((leg) => leg.rows === 2 && leg.truncated), "no tenant was read past two");

      // Where a missing value goes holds across tenants as it does in one.
      yield* db.forTenant("cosmo").documents.insert({ collection: "posts", id: "p9", data: { title: "unranked" } });
      const nullsFirst = yield* db.scatter.findMany({
        collection: "posts", orderBy: [{ path: "rank", nulls: "first" }], limit: 2,
      });
      assert.deepEqual(nullsFirst.rows.map(key), ["cosmo/p9", "acme/p1"]);
      const nullsLast = yield* db.scatter.findMany({ collection: "posts", orderBy: [{ path: "rank" }] });
      assert.equal(key(nullsLast.rows.at(-1)), "cosmo/p9");
    }),
  );
});

test("a scatter pages by value, resuming every tenant where the merge left it", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);

      for (const limit of [1, 3, 7, 50]) {
        for (const concurrency of [1, 8]) {
          const pages = yield* walkScatter(db, { orderBy: BY_RANK_DESC, limit, concurrency });
          assert.deepEqual(pages.flatMap((page) => page.rows.map(key)), RANK_DESC, `${limit} per page`);
          assert.ok(pages.every((page) => page.rows.length > 0), `an empty page at ${limit} per page`);
        }
      }

      // A page reads a share of itself from each tenant, not a page from each.
      const first = yield* db.scatter.findPage({ collection: "posts", orderBy: BY_RANK_DESC, limit: 3 });
      assert.deepEqual(first.rows.map(key), RANK_DESC.slice(0, 3));
      assert.ok(first.legs.every((leg) => leg.read <= 2), JSON.stringify(first.legs));
      assert.equal(first.legs.reduce((n, leg) => n + leg.rows, 0), 3);
      assert.ok(first.shards > 1);
    }),
  );
});

test("without an order, a scatter pages tenant by tenant in identifier order", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const pages = yield* walkScatter(db, { limit: 3 });
      assert.deepEqual(pages.flatMap((page) => page.rows.map(key)),
        TENANTS.flatMap((tenant) => [1, 2, 3, 4].map((i) => `${tenant}/p${i}`)));
    }),
  );
});

test("a continued scatter keeps the tenants and the order it began with", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const first = yield* db.scatter.findPage({ collection: "posts", orderBy: BY_RANK_DESC, limit: 3 });

      // A tenant arriving mid-read would put its rank 9 before rows already
      // returned; it is left to the next read instead of breaking this one.
      const late = db.forTenant("foxtrot").documents;
      yield* late.createCollection({ name: "posts" });
      yield* late.insert({ collection: "posts", id: "p1", data: { title: "foxtrot-9", rank: 9 } });
      const rest = yield* walkScatter(db, { orderBy: BY_RANK_DESC, limit: 5 }, first.next);
      assert.deepEqual([...first.rows, ...rest.flatMap((page) => page.rows)].map(key), RANK_DESC);
      const fresh = yield* db.scatter.findPage({ collection: "posts", orderBy: BY_RANK_DESC, limit: 1 });
      assert.deepEqual(fresh.rows.map(key), ["foxtrot/p1"]);

      const tagOf = (effect) => Effect.map(Effect.flip(effect), (error) => error._tag);
      const again = (input) => tagOf(db.scatter.findPage({ collection: "posts", after: first.next, ...input }));
      assert.equal(yield* again({ orderBy: [{ path: "rank" }] }), "CursorMismatch");
      assert.equal(yield* again({ orderBy: BY_RANK_DESC, collection: "other" }), "CursorMismatch");
      assert.equal(yield* again({ orderBy: BY_RANK_DESC, tenants: ["acme"] }), "CursorMismatch");
      assert.equal(yield* again({ orderBy: BY_RANK_DESC, after: "garbage" }), "CursorMismatch");
    }),
  );
});

test("an order one tenant cannot page is refused, naming the tenant", async (t) => {
  await withDatabase(t, (db) =>
    Effect.gen(function* () {
      yield* seed(db);
      const orderBy = [{ path: "rank" }, { path: "title" }];
      const index = (tenant) => db.forTenant(tenant).documents.createIndex({
        collection: "posts", name: "by_rank_title", fields: orderBy,
      });
      for (const tenant of TENANTS.filter((tenant) => tenant !== "delta")) yield* index(tenant);

      const refused = yield* Effect.flip(db.scatter.findPage({ collection: "posts", orderBy }));
      assert.equal(refused._tag, "UnsupportedOrdering");
      assert.match(refused.reason, /tenant "delta"/);

      yield* index("delta");
      const pages = yield* walkScatter(db, { orderBy, limit: 4 });
      assert.deepEqual(pages.flatMap((page) => page.rows.map(key)),
        [1, 2, 3, 4].flatMap((rank) => TENANTS.map((tenant) => `${tenant}/p${rank}`)));
    }),
  );
});
