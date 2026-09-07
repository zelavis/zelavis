import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor, runtimeApiFor } from "../dist/dbnew/index.js";
import { makeNodeSqliteStore } from "../dist/dbnew/adapters/node-sqlite.js";

// The runtime boundary is used from plain async code, exactly as a route handler
// would, so these tests deliberately contain no Effect beyond opening the store.
const withRuntime = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["s0", "s1"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        // The shards stay open for as long as the plain-async body runs.
        yield* Effect.promise(() => body(runtimeApiFor(db, { nodeId: "node-a" })));
      }),
    ),
  );
};

test("runtime api: documents round-trip through plain promises", async (t) => {
  await withRuntime(t, async (api) => {
    const tenant = api.forTenant("acme");
    assert.equal(api.context.nodeId, "node-a");
    assert.equal(typeof api.shardOf("acme"), "string");

    await tenant.documents.createCollection({ name: "posts" });
    assert.equal(await tenant.documents.collectionExists("posts"), true);

    const created = await tenant.documents.insert({
      collection: "posts", id: "p1", data: { title: "Atlas", views: 1 },
    });
    assert.equal(created.version, 1);

    const found = await tenant.documents.findById({ collection: "posts", id: "p1" });
    assert.equal(found.data.title, "Atlas");

    const updated = await tenant.documents.update({
      collection: "posts", id: "p1", data: { views: 2 },
    });
    assert.equal(updated.data.views, 2);

    const many = await tenant.documents.findMany({
      collection: "posts", where: [{ path: "title", value: "Atlas" }],
    });
    assert.deepEqual(many.map((d) => d.id), ["p1"]);

    assert.equal(await tenant.documents.delete({ collection: "posts", id: "p1" }), true);
  });
});

test("runtime api: a domain failure rejects with its tagged error", async (t) => {
  await withRuntime(t, async (api) => {
    const tenant = api.forTenant("acme");
    await tenant.documents.createCollection({ name: "posts" });
    await tenant.documents.insert({ collection: "posts", id: "p1", data: { n: 1 } });

    // A route needs the tag to choose a status code, so it has to survive the
    // crossing rather than becoming an opaque rejection.
    await assert.rejects(
      () => tenant.documents.insert({ collection: "posts", id: "p1", data: { n: 2 } }),
      (error) => {
        const cause = error.cause ?? error;
        assert.equal(cause._tag ?? cause.error?._tag, "DocumentConflict");
        return true;
      },
    );

    await assert.rejects(
      () => tenant.documents.insert({ collection: "absent", data: {} }),
      (error) => {
        const cause = error.cause ?? error;
        assert.equal(cause._tag ?? cause.error?._tag, "CollectionNotFound");
        return true;
      },
    );
  });
});

test("runtime api: schemas, events, views and backups are all tenant scoped", async (t) => {
  await withRuntime(t, async (api) => {
    const acme = api.forTenant("acme");
    const globex = api.forTenant("globex");

    await acme.documents.createCollection({ name: "posts" });
    await acme.schemas.save({
      collection: "posts",
      version: 1,
      fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }],
    });
    await acme.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
    await globex.documents.createCollection({ name: "secrets" });

    assert.deepEqual((await acme.schemas.listCollections()).map((s) => s.collection), ["posts"]);
    assert.deepEqual(await globex.schemas.listCollections(), [], "schemas do not leak");
    assert.equal((await acme.schemas.getActive("posts")).version, 1);

    const validation = await acme.schemas.validate("posts", { title: 42 });
    assert.equal(validation.valid, false);

    const events = await acme.events.read();
    assert.ok(events.every((e) => e.tenantId === "acme"));

    const views = acme.systemViews.list();
    assert.equal(views.length, 5);
    const collections = await acme.systemViews.query({ name: "collections" });
    assert.deepEqual(collections.rows.map((r) => r.id), ["posts"]);

    const backup = await acme.backups.exportTenant();
    assert.ok(backup.events.length > 0);
    assert.equal(backup.tenantId, "acme");
  });
});

test("runtime api: projections and time series drive from plain promises", async (t) => {
  await withRuntime(t, async (api) => {
    const tenant = api.forTenant("acme");
    await tenant.documents.createCollection({ name: "posts" });
    await tenant.documents.insert({ collection: "posts", id: "p1", data: { views: 5 } });

    assert.deepEqual(await tenant.projections.list(), []);
    assert.deepEqual(await tenant.timeSeries.list(), []);

    const range = await tenant.timeSeries.range("absent").catch(() => "rejected");
    assert.deepEqual(range, [], "an undefined series simply has no points");
  });
});
