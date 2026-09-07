import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeDatabase, partitionMapFor } from "../dist/dbnew/index.js";
import { makeNodeSqliteStore } from "../dist/dbnew/adapters/node-sqlite.js";

const fields = [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }];

const withDb = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-views-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = yield* makeDatabase({
          partitionMap: partitionMapFor(["only"]),
          openShard: (shard) => makeNodeSqliteStore(shard, dir),
        });
        return yield* body(db);
      }),
    ),
  );
};

const populate = (tenant) =>
  Effect.gen(function* () {
    yield* tenant.documents.createCollection({ name: "posts", surface: "content-studio" });
    yield* tenant.schemas.save({ collection: "posts", version: 1, fields });
    yield* tenant.documents.insert({ collection: "posts", id: "p1", data: { title: "Atlas" } });
    yield* tenant.projections.register({ name: "titles", apply: () => Effect.void });
    yield* tenant.timeSeries.define({
      name: "views",
      map: () => null,
    });
  });

test("system views: every view is listed and queryable", async (t) => {
  await withDb(t, (db) =>
    Effect.gen(function* () {
      const tenant = db.forTenant("acme");
      yield* populate(tenant);
      const views = tenant.systemViews;

      assert.deepEqual(
        views.list().map((v) => v.name),
        ["collections", "events", "schemas", "projections", "time-series"],
      );
      assert.ok(views.list().every((v) => v.tenantScoped), "every view is tenant scoped");

      const collections = yield* views.query({ name: "collections" });
      assert.deepEqual(collections.rows.map((r) => r.id), ["posts"]);
      assert.equal(collections.rows[0].data.surface, "content-studio");

      const schemas = yield* views.query({ name: "schemas" });
      assert.deepEqual(schemas.rows.map((r) => r.id), ["posts"]);
      assert.equal(schemas.rows[0].data.activeVersion, 1);

      const projections = yield* views.query({ name: "projections" });
      assert.deepEqual(projections.rows.map((r) => r.id), ["titles"]);

      const series = yield* views.query({ name: "time-series" });
      assert.deepEqual(series.rows.map((r) => r.id), ["views"]);
      assert.equal(series.rows[0].data.bucket, "day");

      const events = yield* views.query({ name: "events" });
      assert.deepEqual(
        events.rows.map((r) => r.data.type),
        ["collection.created", "document.upserted"],
      );

      const unknown = yield* views.query({ name: "zv_events" }).pipe(
        Effect.as("queried"),
        Effect.catchTag("UnknownSystemView", () => Effect.succeed("rejected")),
      );
      assert.equal(unknown, "rejected", "a physical table name is not a view");
    }),
  );
});

test("system views: paging continues without repeating or dropping rows", async (t) => {
  await withDb(t, (db) =>
    Effect.gen(function* () {
      const tenant = db.forTenant("acme");
      for (let i = 0; i < 7; i++) {
        yield* tenant.documents.createCollection({ name: `c${i}` });
      }
      const views = tenant.systemViews;

      const seen = [];
      let cursor;
      for (let guard = 0; guard < 10; guard++) {
        const result = yield* views.query({
          name: "collections", limit: 3, ...(cursor === undefined ? {} : { after: cursor }),
        });
        seen.push(...result.rows.map((r) => r.id));
        cursor = result.next;
        if (cursor === undefined) break;
      }
      assert.equal(cursor, undefined, "paging terminates");
      assert.deepEqual(seen, ["c0", "c1", "c2", "c3", "c4", "c5", "c6"], "each row once, in order");

      // The event view forwards the log's own continuation.
      const first = yield* views.query({ name: "events", limit: 2 });
      assert.equal(first.rows.length, 2);
      assert.ok(first.next, "more to read");
      const second = yield* views.query({ name: "events", limit: 2, after: first.next });
      assert.ok(
        second.rows.every((r) => !first.rows.some((f) => f.id === r.id)),
        "no event is returned twice",
      );
    }),
  );
});

test("system views: one tenant never sees another's rows", async (t) => {
  await withDb(t, (db) =>
    Effect.gen(function* () {
      const acme = db.forTenant("acme");
      const globex = db.forTenant("globex");
      yield* populate(acme);
      yield* globex.documents.createCollection({ name: "secrets" });

      const mine = yield* acme.systemViews.query({ name: "collections" });
      assert.deepEqual(mine.rows.map((r) => r.id), ["posts"]);

      const theirs = yield* globex.systemViews.query({ name: "collections" });
      assert.deepEqual(theirs.rows.map((r) => r.id), ["secrets"]);

      // Schemas are per tenant here, unlike the surface being replaced.
      assert.deepEqual((yield* globex.systemViews.query({ name: "schemas" })).rows, []);
      assert.deepEqual((yield* globex.systemViews.query({ name: "projections" })).rows, []);

      const events = yield* globex.systemViews.query({ name: "events" });
      assert.ok(
        events.rows.every((r) => r.data.collection === "secrets"),
        "the event view is scoped too",
      );
    }),
  );
});

test("system views: a limit cannot be used to ask for unbounded rows", async (t) => {
  await withDb(t, (db) =>
    Effect.gen(function* () {
      const tenant = db.forTenant("acme");
      for (let i = 0; i < 12; i++) {
        yield* tenant.documents.createCollection({ name: `c${i}` });
      }
      const views = tenant.systemViews;

      assert.equal((yield* views.query({ name: "collections", limit: 5 })).rows.length, 5);
      // Nonsense limits fall back to the default rather than failing or scanning.
      assert.equal((yield* views.query({ name: "collections", limit: 0 })).rows.length, 12);
      assert.equal((yield* views.query({ name: "collections", limit: -3 })).rows.length, 12);
      assert.equal((yield* views.query({ name: "collections", limit: 10_000 })).rows.length, 12);

      // A malformed cursor restarts rather than throwing.
      const restarted = yield* views.query({ name: "collections", after: "not-a-cursor" });
      assert.equal(restarted.rows[0].id, "c0");
    }),
  );
});
