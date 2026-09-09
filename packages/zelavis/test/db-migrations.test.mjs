import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  defaultField, dropField, makeDatabase, partitionMapFor, renameField, setField,
} from "../dist/db/index.js";
import { makeNodeSqliteStore } from "../dist/db/engines/node-sqlite.js";

const text = (label, required) => ({ _tag: "TextField", label, required });
const number = (label, required) => ({ _tag: "NumberField", label, required });

const withTenant = (t, body) => {
  const dir = mkdtempSync(join(tmpdir(), "zv-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const db = yield* makeDatabase({
        partitionMap: partitionMapFor(["s0"]),
        openShard: (shard) => makeNodeSqliteStore(shard, dir),
      });
      const tenant = db.forTenant("acme");
      yield* tenant.documents.createCollection({ name: "posts" });
      return yield* body(tenant);
    })),
  );
};

/** Version 1: a title and an optional body. */
const v1 = {
  collection: "posts",
  version: 1,
  activate: true,
  fields: [
    { name: "title", field: text("Title", true) },
    { name: "body", field: text("Body", false) },
  ],
};

const seed = (tenant, rows) =>
  Effect.gen(function* () {
    yield* tenant.schemas.save(v1);
    for (const [id, data] of rows) {
      yield* tenant.documents.insert({ collection: "posts", id, data });
    }
  });

test("a plan says what changed and what the caller still has to decide", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "one" }], ["p2", { title: "Beacon" }]]);

      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "summary", field: text("Summary", true) },
          { name: "views", field: number("Views", false) },
        ],
      });

      const plan = yield* tenant.migrations.plan("posts", { to: 2 });
      assert.equal(plan.from, 1);
      assert.equal(plan.to, 2);
      assert.equal(plan.documents, 2);

      const byPath = Object.fromEntries(plan.differences.map((d) => [d.path, d]));
      assert.equal(byPath.summary.change, "added");
      assert.equal(byPath.summary.blocking, true, "a new required field needs a value");
      assert.equal(byPath.views.change, "added");
      assert.equal(byPath.views.blocking, false, "a new optional field needs nothing");
      assert.equal(byPath.body.change, "removed");
      assert.equal(byPath.body.blocking, false, "a field the new version drops is discarded");

      assert.deepEqual(plan.discards, ["body"], "and says so before it happens");
      assert.deepEqual(plan.unresolved.map((d) => d.path), ["summary"]);

      // Supplying a value for it resolves the plan without running anything.
      const answered = yield* tenant.migrations.plan("posts", {
        to: 2, apply: [setField("summary", "none")],
      });
      assert.deepEqual(answered.unresolved, []);
    }),
  );
});

test("a migration missing an instruction refuses before touching anything", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "one" }]]);
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "summary", field: text("Summary", true) },
        ],
      });

      const blocked = yield* Effect.flip(tenant.migrations.migrate("posts", { to: 2 }));
      assert.equal(blocked._tag, "SchemaMigrationBlocked");
      assert.equal(blocked.collection, "posts");
      assert.equal(blocked.from, 1);
      assert.equal(blocked.to, 2);
      assert.match(blocked.unresolved[0], /^summary: added/);

      // Nothing moved: the old version is still in force and the document is
      // as it was.
      assert.equal((yield* tenant.schemas.getActive("posts")).version, 1);
      const doc = yield* tenant.documents.findById({ collection: "posts", id: "p1" });
      assert.deepEqual(doc.data, { title: "Atlas", body: "one" });
      assert.equal(doc.version, 1);
    }),
  );
});

test("a migration fills, renames and discards, then activates", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [
        ["p1", { title: "Atlas", body: "long one" }],
        ["p2", { title: "Beacon" }],
      ]);

      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "headline", field: text("Headline", true) },
          { name: "summary", field: text("Summary", true) },
          { name: "views", field: number("Views", false) },
        ],
      });

      const result = yield* tenant.migrations.migrate("posts", {
        to: 2,
        apply: [
          renameField("title", "headline"),
          defaultField("summary", "no summary"),
        ],
      });

      assert.deepEqual(result.failures, []);
      assert.equal(result.migrated, 2);
      assert.equal(result.activated, true);
      assert.equal((yield* tenant.schemas.getActive("posts")).version, 2);

      const docs = yield* tenant.documents.findMany({ collection: "posts" });
      const byId = Object.fromEntries(docs.map((d) => [d.id, d.data]));
      assert.deepEqual(byId.p1, { headline: "Atlas", summary: "no summary" },
        "renamed, filled, and the dropped field is gone");
      assert.deepEqual(byId.p2, { headline: "Beacon", summary: "no summary" });

      // The collection now accepts the new shape and refuses the old one.
      yield* tenant.documents.insert({
        collection: "posts", id: "p3", data: { headline: "Cobalt", summary: "s" },
      });
      const stale = yield* Effect.flip(tenant.documents.insert({
        collection: "posts", id: "p4", data: { title: "Delta", body: "x" },
      }));
      assert.equal(stale._tag, "SchemaViolation");
    }),
  );
});

test("a document that would still be invalid stops the whole migration", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [
        ["p1", { title: "Atlas", body: "12" }],
        ["p2", { title: "Beacon", body: "not a number" }],
      ]);

      // The body becomes a number, which one of these two cannot be.
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "body", field: number("Body", false) },
        ],
      });

      const first = yield* tenant.migrations.migrate("posts", {
        to: 2, apply: [setField("body", 0)],
      });
      assert.equal(first.migrated, 2, "setup: the retype succeeds when told what to write");

      // Now ask for something that cannot be valid, so the refusal is the
      // migration's own judgement rather than a missing instruction.
      yield* tenant.schemas.save({
        collection: "posts",
        version: 3,
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "body", field: number("Body", false) },
          { name: "rank", field: number("Rank", true) },
        ],
      });
      const bad = yield* tenant.migrations.migrate("posts", {
        from: 2, to: 3, apply: [setField("rank", "high")],
      });

      assert.equal(bad.failures.length, 2, "both documents would be invalid");
      assert.equal(bad.migrated, 0, "so none of them were written");
      assert.equal(bad.activated, false, "and the version was not activated");
      assert.equal((yield* tenant.schemas.getActive("posts")).version, 2);
      assert.match(bad.failures[0].issues[0].path, /rank/);
    }),
  );
});

test("a dry run answers the question and changes nothing", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "one" }]]);
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "summary", field: text("Summary", true) },
        ],
      });

      const dry = yield* tenant.migrations.migrate("posts", {
        to: 2, apply: [defaultField("summary", "none")], dryRun: true,
      });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.migrated, 1, "it says what it would write");
      assert.equal(dry.activated, false);
      assert.deepEqual(dry.failures, []);

      assert.equal((yield* tenant.schemas.getActive("posts")).version, 1);
      assert.deepEqual(
        (yield* tenant.documents.findById({ collection: "posts", id: "p1" })).data,
        { title: "Atlas", body: "one" },
      );

      // And running it for real does what the dry run said.
      const real = yield* tenant.migrations.migrate("posts", {
        to: 2, apply: [defaultField("summary", "none")],
      });
      assert.equal(real.migrated, 1);
      assert.equal(real.activated, true);
    }),
  );
});

test("running a finished migration again is a no-op", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "one" }]]);
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "headline", field: text("Headline", true) },
          { name: "summary", field: text("Summary", true) },
        ],
      });

      const apply = [renameField("title", "headline"), defaultField("summary", "none")];
      const first = yield* tenant.migrations.migrate("posts", { to: 2, apply });
      assert.equal(first.migrated, 1);
      const after = yield* tenant.documents.findById({ collection: "posts", id: "p1" });

      // An interrupted migration is finished by asking for it again, so every
      // instruction has to be safe to re-apply. A rename that fired on an
      // absent field would blank the new one.
      const second = yield* tenant.migrations.migrate("posts", { from: 1, to: 2, apply });
      assert.deepEqual(second.failures, []);
      assert.equal(second.migrated, 0, "nothing left to change");
      assert.equal(second.unchanged, 1);

      const again = yield* tenant.documents.findById({ collection: "posts", id: "p1" });
      assert.deepEqual(again.data, after.data);
      assert.equal(again.version, after.version, "and no version was burned on a rewrite");
    }),
  );
});

test("a migration can move a value out of a field it is about to discard", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "keep me" }]]);
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "content", field: text("Content", true) },
        ],
      });

      // Discarding unknown fields happens after the instructions, so a rename
      // out of a doomed field still carries the value.
      const result = yield* tenant.migrations.migrate("posts", {
        to: 2, apply: [renameField("body", "content")],
      });
      assert.deepEqual(result.failures, []);
      assert.deepEqual(
        (yield* tenant.documents.findById({ collection: "posts", id: "p1" })).data,
        { title: "Atlas", content: "keep me" },
      );
    }),
  );
});

test("a version that does not exist is refused", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas" }]]);
      const missing = yield* Effect.flip(tenant.migrations.plan("posts", { to: 9 }));
      assert.equal(missing._tag, "SchemaNotFound");
      assert.equal(missing.version, 9);

      const noSource = yield* Effect.flip(
        tenant.migrations.plan("posts", { from: 7, to: 1 }));
      assert.equal(noSource._tag, "SchemaNotFound");
      assert.equal(noSource.version, 7);
    }),
  );
});

test("an explicit drop is honoured alongside the automatic ones", async (t) => {
  await withTenant(t, (tenant) =>
    Effect.gen(function* () {
      yield* seed(tenant, [["p1", { title: "Atlas", body: "one" }]]);
      yield* tenant.schemas.save({
        collection: "posts",
        version: 2,
        // Saved inactive: activating is what the migration does, once the
        // documents are in a shape the version accepts.
        activate: false,
        fields: [
          { name: "title", field: text("Title", true) },
          { name: "body", field: text("Body", false) },
        ],
      });

      // Nothing about the schemas says to clear this; the caller does.
      const result = yield* tenant.migrations.migrate("posts", {
        to: 2, apply: [dropField("body")],
      });
      assert.equal(result.migrated, 1);
      assert.deepEqual(
        (yield* tenant.documents.findById({ collection: "posts", id: "p1" })).data,
        { title: "Atlas" },
      );
    }),
  );
});
