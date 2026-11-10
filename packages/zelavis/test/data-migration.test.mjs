import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit, Cause } from "effect";
import { migrateDataLayout } from "../dist/adapters/_node-data-migration.js";
import { openNodeDatabase } from "../dist/db/node-host.js";

// The earlier engine is replaced by a stand-in release tree whose database "opens" whatever `fake.json` in the shard
// directory says it holds. This exercises the real worker process, export files, recreation and verification.
// The format-migration harness covers the published engines themselves.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const collection = (tenant, name, extra = {}, at = 0) => ({ kind: "put", seq: 1, version: 1, at, identity: { namespace: `zv.collection/${tenant}`, key: name }, body: b64({ name, surface: "database", ...extra }) });
const document = (tenant, name, seq, id, data, version = 1, extra = {}, at = 0) => ({ kind: "put", seq, version, at, identity: { namespace: `doc/${tenant}/${name}`, key: id }, body: b64({ id, collection: name, data, version, ...extra }) });
const retractOf = (seq, version, ms = 0) => ({ kind: "retract", seq, version, at: ms });
const iso = (ms) => new Date(ms).toISOString();
const CREATED = "2026-10-01T08:00:00.000Z", UPDATED = "2026-10-20T17:30:00.000Z", EXPIRES = "2027-01-01T00:00:00.000Z";

async function earlierRelease(root, crash, sourceFormat) {
  const platform = join(root, "platform");
  await mkdir(join(platform, "dist", "db"), { recursive: true });
  await mkdir(join(platform, "node_modules", "effect", "dist"), { recursive: true });
  await writeFile(join(platform, "node_modules", "effect", "package.json"), JSON.stringify({ name: "effect", type: "module" }));
  await writeFile(join(platform, "node_modules", "effect", "dist", "index.js"), "export const Effect = { runPromise: async (program) => (typeof program === 'function' ? program() : program) };\n");
  await writeFile(join(platform, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(platform, "dist", "db", "node-host.js"), `
import { readFile } from "node:fs/promises"; import { join } from "node:path";
const decode = (body) => JSON.parse(Buffer.from(body, "base64").toString("utf8"));
export const openNodeDatabase = async ({ directory }) => {
  ${crash ? 'throw new Error("earlier engine crashed while opening");' : ""}
  const fake = JSON.parse(await readFile(join(directory, "fake.json"), "utf8"));
  const tenants = Object.keys(fake).filter((key) => !key.startsWith("__"));
  const sourceFormat = ${sourceFormat};
  const collectionNamespace = (tenant) => sourceFormat === 2 ? "zv.collection/" + tenant : "zv.collection";
  const documentPrefix = (tenant) => sourceFormat === 2 ? "doc/" + tenant + "/" : "doc/";
  const live = (tenant) => { const bySeq = new Map(); for (const e of fake[tenant]) { if (e.kind === "retract") bySeq.delete(e.seq); else bySeq.set(e.seq, e); } return [...bySeq.values()]; };
  const documents = (tenant, collection) => [
    ...live(tenant).filter((e) => e.identity?.namespace === documentPrefix(tenant) + collection).map((e) => decode(e.body)),
    ...((fake.__extraDocuments ?? {})[tenant] ?? []).filter((d) => d.collection === collection),
  ];
  return { close: async () => {}, database: {
    tenants: () => tenants,
    shardOf: () => "shard-0",
    followers: { source: (partition) => ({ stats: () => ({
      head: fake[partition].length, compactedTo: fake.__compactedTo ?? 0, lineage: fake.__lineage,
    }) }) },
    maintenance: { status: () => sourceFormat === 2
      ? [{ shard: "shard-0", records: 0, bytes: 0, compactedTo: fake.__compactedTo ?? 0 }]
      : tenants.map((partition) => ({ shard: "shard-0", partition, compactedTo: fake.__compactedTo ?? 0 })) },
    forTenant: (tenant) => ({
      backups: { exportTenant: () => ({ events: fake[tenant] }) },
      documents: {
        listCollections: () => live(tenant).filter((e) => e.identity?.namespace === collectionNamespace(tenant)).map((e) => decode(e.body)),
        findPage: ({ collection }) => ({ documents: documents(tenant, collection) }),
      },
    }),
  } };
};\n`);
  return platform;
}

async function fixture(contents, { crash = false, sourceFormat = 2 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-data-migration-"));
  const source = join(root, "old-shards");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "fake.json"), JSON.stringify(contents));
  const oldPlatform = await earlierRelease(join(root, "old-release"), crash, sourceFormat);
  const input = { sourceShards: source, sourceFormat, workDirectory: join(root, "work"), oldNode: process.execPath, oldPlatform, exportWorker: new URL("../dist/adapters/_data-export-worker.js", import.meta.url).pathname };
  return { root, source, input };
}
const listing = async (dir) => (await readdir(dir)).sort().join(",");
const failure = async (effect) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected the migration to fail");
  return String(Cause.squash(exit.cause).message ?? Cause.squash(exit.cause));
};

const feedOf = async (opened, t) => {
  const out = [];
  let after;
  for (;;) {
    const page = await Effect.runPromise(opened.database.forTenant(t).events.read({ ...(after ? { after } : {}), limit: 1000 }));
    out.push(...page.events);
    after = page.cursor;
    if (!page.more) return out;
  }
};

test("a database written by an earlier layout is recreated through the documents API with its history replayed at its times, and verified", async () => {
  const t = "tenant-a";
  const { root, source, input } = await fixture({
    [t]: [
      collection(t, "users", { indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] }, 1000),
      // Declared by hand, so activating schema v1, whose text field implies this analyzer, changes no lens and adds no event.
      { ...collection(t, "posts", { analyzer: { fields: ["title"], version: 1, fold: true } }, 1000), seq: 2 },
      document(t, "users", 3, "u1", { email: "a@x.test", age: 30 }, 1, {}, 1100),
      document(t, "users", 4, "u2", { email: "b@x.test", age: 38 }, 1, { createdAt: CREATED, updatedAt: CREATED }, 1200),
      document(t, "users", 4, "u2", { email: "b@x.test", age: 39 }, 2, { createdAt: CREATED, updatedAt: CREATED }, 1300),
      document(t, "users", 4, "u2", { email: "b@x.test", age: 40 }, 3, { createdAt: CREATED, updatedAt: UPDATED, expiresAt: EXPIRES }, 1400),
      document(t, "posts", 5, "p1", { title: "hello" }, 1, {}, 1500),
      document(t, "posts", 6, "p2", { title: "gone" }, 1, {}, 1600),
      retractOf(6, 2, 1700),
      { kind: "put", seq: 7, version: 1, at: 1800, identity: { namespace: `zv.idempotency/${t}`, key: "key-1" }, body: b64({ done: true }) },
      { kind: "put", seq: 8, version: 1, at: 1800, identity: { namespace: "zv.schema", key: `${t}/posts/1` }, body: b64({ collection: "posts", version: 1, active: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: false } }] }) },
      { kind: "put", seq: 9, version: 1, at: 1800, identity: { namespace: "zv.schema", key: `${t}/posts/2` }, body: b64({ collection: "posts", version: 2, active: false, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }) },
      { kind: "put", seq: 10, version: 1, at: 1800, identity: { namespace: "zv.schema.active", key: `${t}/posts` }, body: b64({ version: 1 }) },
    ],
    "tenant-empty": [],
  });
  try {
    const before = await readFile(join(source, "fake.json"), "utf8");
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.equal(report.tenants, 2);
    assert.equal(report.collections, 2);
    assert.equal(report.schemas, 2, "every saved schema version is recreated");
    assert.equal(report.documents, 3, "the retracted post is not a document any more");
    assert.equal(report.eventsCarried, 7, "every put and the deletion");
    assert.equal(report.tenantsWithoutHistory, 0);
    assert.equal(report.documentsWithHistoryDropped, 0, "u2's earlier versions are carried as events");
    assert.equal(report.eventsOfDroppedCollections, 0);
    assert.deepEqual(report.dropped, { "zv.idempotency": 1 });
    assert.equal(await readFile(join(source, "fake.json"), "utf8"), before, "the source is never written");

    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const feed = await feedOf(opened, t);
      assert.deepEqual(feed.slice(0, 2).map((event) => [event.type, event.timestamp]), [["collection.created", iso(1000)], ["collection.created", iso(1000)]],
        "each collection is created once, at the time of the Tenant's first event");
      assert.deepEqual(feed.filter((event) => event.documentId !== undefined).map((event) => [event.type, event.documentId, event.revision, event.timestamp]), [
        ["document.upserted", "u1", 1, iso(1100)],
        ["document.upserted", "u2", 1, iso(1200)],
        ["document.upserted", "u2", 2, iso(1300)],
        ["document.upserted", "u2", 3, iso(1400)],
        ["document.upserted", "p1", 1, iso(1500)],
        ["document.upserted", "p2", 1, iso(1600)],
        ["document.deleted", "p2", 2, iso(1700)],
      ], "the document history, one event per earlier event, in order, at its time and revision");
      const carried = feed.filter((event) => event.documentId !== undefined || event.type === "collection.created").map((event) => event.timestamp);
      assert.deepEqual(carried, [...carried].sort(), "the carried log reads in time order");
      assert.deepEqual(feed.filter((event) => event.documentId !== undefined).map((event) => event.payload.data?.age).filter((age) => age !== undefined), [30, 38, 39, 40],
        "each event carries the data of its own version");

      const documents = opened.database.forTenant(t).documents;
      assert.deepEqual((await Effect.runPromise(documents.findMany({ collection: "users", orderBy: [{ path: "email" }] }))).map((d) => [d.id, d.data.age]), [["u1", 30], ["u2", 40]]);
      assert.equal(await Effect.runPromise(documents.count({ collection: "posts" })), 1);
      const u2 = await Effect.runPromise(documents.findById({ collection: "users", id: "u2" }));
      assert.deepEqual([u2.version, u2.createdAt, u2.updatedAt, u2.expiresAt], [3, CREATED, UPDATED, EXPIRES], "the version, both times and the expiry are the earlier engine's");
      const u1 = await Effect.runPromise(documents.findById({ collection: "users", id: "u1" }));
      assert.deepEqual([u1.version, u1.createdAt, u1.updatedAt], [1, iso(1100), iso(1100)], "a document the earlier engine kept without times takes its event's");
      // A client that read u2 at version 2 before the migration must still be refused: had the version restarted at one,
      // the same stale write would pass once the document had been written twice more and overwrite the newer data.
      const stale = await Effect.runPromiseExit(documents.update({ collection: "users", id: "u2", data: { age: 1 }, expectedVersion: 2 }));
      assert.ok(Exit.isFailure(stale), "a version read before the migration is still judged against the same document state");
      assert.equal(Cause.squash(stale.cause)._tag, "DocumentConflict");
      const current = await Effect.runPromise(documents.update({ collection: "users", id: "u2", data: { age: 41 }, expectedVersion: 3 }));
      assert.equal(current.version, 4, "a write that read the current version goes on from it");
      const eq = await Effect.runPromise(documents.findMany({ collection: "users", where: [{ path: "email", op: "eq", value: "b@x.test" }] }));
      assert.deepEqual(eq.map((d) => d.id), ["u2"], "the recreated index answers");
      assert.deepEqual((await Effect.runPromise(documents.findMany({ collection: "posts", search: "hello" }))).map((d) => d.id), ["p1"], "the replayed text is searchable");
      const versions = await Effect.runPromise(opened.database.forTenant(t).schemas.listVersions("posts"));
      assert.deepEqual(versions.map((v) => [v.version, v.active]), [[1, true], [2, false]], "the active schema stays the active one");
    } finally { await opened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a database written in layout 4 names nothing by its tenant, and is recreated the same way", async () => {
  const t = "tenant-a";
  // Layout 4 as alpha.43 and alpha.44 export it: a partition per Tenant, so no name carries the tenant.
  const { root, input } = await fixture({
    __compactedTo: 1,
    [t]: [
      { kind: "put", seq: 1, version: 1, at: 0, identity: { namespace: "zv.collection", key: "users" }, body: b64({ name: "users", surface: "database", columns: ["email", "age"], referencedBy: [{ collection: "posts", reference: "author" }] }) },
      { kind: "put", seq: 2, version: 1, at: 0, identity: { namespace: "zv.collection", key: "posts" }, body: b64({ name: "posts", surface: "database", references: [{ name: "author", path: "author", collection: "users", onDelete: "restrict" }] }) },
      { kind: "put", seq: 3, version: 2, at: 0, identity: { namespace: "doc/users", key: "u1" }, body: b64({ id: "u1", collection: "users", data: { email: "a@x.test", age: 30 }, version: 2, createdAt: CREATED, updatedAt: UPDATED, expiresAt: EXPIRES }) },
      { kind: "put", seq: 4, version: 1, at: 0, identity: { namespace: "doc/posts", key: "p1" }, body: b64({ id: "p1", collection: "posts", data: { title: "hello", author: "u1" }, version: 1, createdAt: CREATED, updatedAt: CREATED }) },
      { kind: "put", seq: 5, version: 1, at: 0, identity: { namespace: "zv.idempotency", key: "key-1" }, body: b64({ done: true }),
        manifest: { terms: [], columns: [], measures: [], edges: [] } },
      { kind: "put", seq: 6, version: 1, at: 0, identity: { namespace: "zv.schema", key: "posts/1" }, body: b64({ collection: "posts", version: 1, active: false, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: false } }] }) },
      { kind: "put", seq: 7, version: 1, at: 0, identity: { namespace: "zv.schema.active", key: "posts" }, body: b64({ version: 1 }) },
    ],
  }, { sourceFormat: 4 });
  try {
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.deepEqual([report.tenants, report.collections, report.schemas, report.documents, report.documentsWithHistoryDropped], [1, 2, 1, 2, 1]);
    assert.deepEqual(report.dropped, {});
    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const tenant = opened.database.forTenant(t);
      const backup = await Effect.runPromise(tenant.backups.exportTenant);
      assert.equal(backup.events.find((e) => e.identity?.namespace === "zv.idempotency")?.body, b64({ done: true }));
      const u1 = await Effect.runPromise(tenant.documents.findById({ collection: "users", id: "u1" }));
      assert.deepEqual([u1.version, u1.createdAt, u1.updatedAt, u1.expiresAt, u1.data.age], [2, CREATED, UPDATED, EXPIRES, 30]);
      const users = (await Effect.runPromise(tenant.documents.listCollections)).find((c) => c.name === "users");
      assert.deepEqual([...users.columns].sort(), ["age", "email"], "declared columns are carried");
      const older = await Effect.runPromise(tenant.documents.findMany({ collection: "users", where: [{ path: "age", op: "gte", value: 18 }] }));
      assert.deepEqual(older.map((d) => d.id), ["u1"]);
      const versions = await Effect.runPromise(tenant.schemas.listVersions("posts"));
      assert.deepEqual(versions.map((v) => [v.version, v.active]), [[1, true]], "the active schema, keyed by collection alone, is active again");
    } finally { await opened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a layout-4 Tenant branch is refused instead of being detached from its source", async () => {
  const { root, input } = await fixture({
    "branch": [], __lineage: [{ partition: "original", upTo: 2 }],
  }, { sourceFormat: 4 });
  try {
    assert.match(await failure(migrateDataLayout(input)), /branch.*cannot carry its lineage/);
    await assert.rejects(stat(input.workDirectory), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a layout this release cannot read is refused before anything is copied", async () => {
  const { root, input } = await fixture({ "tenant-a": [collection("tenant-a", "users")] }, { sourceFormat: 3 });
  try {
    assert.match(await failure(migrateDataLayout(input)), /layout 3 cannot be migrated.*layouts 2 and 4.*Nothing was changed/);
    await assert.rejects(stat(input.workDirectory), "nothing was staged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("records the migration cannot recreate are named and nothing is left behind", async () => {
  const t = "tenant-a";
  const { root, source, input } = await fixture({ [t]: [collection(t, "users"), { kind: "put", seq: 2, version: 1, at: 0, identity: { namespace: `zv.outbox/${t}`, key: "m1" }, body: b64({}) }] });
  try {
    const before = await listing(source);
    assert.match(await failure(migrateDataLayout(input)), /cannot recreate yet.*zv\.outbox/);
    await assert.rejects(stat(input.workDirectory), "the staging is removed");
    assert.equal(await listing(source), before, "the source is untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an earlier engine that crashes, or an existing staging directory, fails before anything changes", async () => {
  const crashed = await fixture({}, { crash: true });
  try {
    assert.match(await failure(migrateDataLayout(crashed.input)), /export failed.*crashed while opening/);
    await assert.rejects(stat(crashed.input.workDirectory));
  } finally { await rm(crashed.root, { recursive: true, force: true }); }

  const existing = await fixture({});
  try {
    await mkdir(existing.input.workDirectory, { recursive: true });
    await writeFile(join(existing.input.workDirectory, "keep.txt"), "mine");
    assert.match(await failure(migrateDataLayout(existing.input)), /already exists/);
    assert.equal(await readFile(join(existing.input.workDirectory, "keep.txt"), "utf8"), "mine", "a directory the migration did not make is never removed");
  } finally { await rm(existing.root, { recursive: true, force: true }); }
});

test("an export that differs from the earlier engine's own reads is refused as truncated", async () => {
  const t = "t";
  const events = [collection(t, "users"), document(t, "users", 2, "u1", { n: 1 })];
  // The earlier engine holds a document its export lacks, as when the export stopped at the shard's read cap.
  const lacking = await fixture({ [t]: events, __extraDocuments: { [t]: [{ id: "u2", collection: "users", data: {}, version: 1 }] } });
  try {
    const before = await listing(lacking.source);
    assert.match(await failure(migrateDataLayout(lacking.input)), /exit 3.*does not match the earlier engine's own documents \(users\/u2\)/);
    await assert.rejects(stat(lacking.input.workDirectory), "the staging is removed");
    assert.equal(await listing(lacking.source), before, "the source is untouched");
  } finally { await rm(lacking.root, { recursive: true, force: true }); }

  // Or holds a newer version of one: the export lost its last write.
  const stale = await fixture({ [t]: events, __extraDocuments: { [t]: [{ id: "u1", collection: "users", data: { n: 1 }, version: 2 }] } });
  try {
    assert.match(await failure(migrateDataLayout(stale.input)), /exit 3.*does not match the earlier engine's own documents \(users\/u1\)/);
    await assert.rejects(stat(stale.input.workDirectory));
  } finally { await rm(stale.root, { recursive: true, force: true }); }
});

test("a Tenant whose earlier log was compacted exports as state, and only its final documents are recreated", async () => {
  const t = "tenant-a";
  const { root, input } = await fixture({
    __compactedTo: 5,
    [t]: [
      collection(t, "users"),
      document(t, "users", 2, "u1", { n: 1 }),
      document(t, "users", 3, "u2", { n: 2 }, 3, { createdAt: CREATED, updatedAt: UPDATED }),
    ],
  });
  try {
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.deepEqual([report.tenantsWithoutHistory, report.eventsCarried, report.documentsWithHistoryDropped, report.documents], [1, 0, 1, 2]);
    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const feed = (await feedOf(opened, t)).filter((event) => event.documentId !== undefined);
      assert.deepEqual(feed.map((event) => [event.type, event.documentId]), [["document.upserted", "u1"], ["document.upserted", "u2"]], "one event per live document");
      const u2 = await Effect.runPromise(opened.database.forTenant(t).documents.findById({ collection: "users", id: "u2" }));
      assert.deepEqual([u2.version, u2.createdAt, u2.updatedAt], [3, CREATED, UPDATED]);
    } finally { await opened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an export that reaches the earlier engine's cap is refused as possibly truncated", async () => {
  const t = "big";
  const events = [collection(t, "c")];
  for (let seq = 2; seq <= 1_000_001; seq++) events.push({ kind: "retract", seq, version: 1, at: 0 });
  const { root, input } = await fixture({ [t]: events });
  try {
    assert.match(await failure(migrateDataLayout(input)), /export cap/);
    await assert.rejects(stat(input.workDirectory));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a migration that would not fit refuses before copying anything", async () => {
  const { root, source, input } = await fixture({ "tenant-a": [collection("tenant-a", "users")] });
  try {
    await writeFile(join(source, "big.bin"), Buffer.alloc(10_000));
    const before = await listing(source);
    assert.match(await failure(migrateDataLayout({ ...input, freeBytes: 10_000 })), /not enough free space.*Nothing was changed/);
    await assert.rejects(stat(input.workDirectory), "nothing was staged");
    assert.equal(await listing(source), before);
    const report = await Effect.runPromise(migrateDataLayout({ ...input, freeBytes: 10_000 * 4 }));
    assert.equal(report.collections, 1, "with room it runs");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("intermediate states the final constraints refuse are carried, and the earlier engine's cascade is not run again", async () => {
  const t = "tenant-a";
  const users = { indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }], checks: [{ name: "adult", where: [{ path: "age", op: "gte", value: 18 }] }] };
  const { root, input } = await fixture({
    [t]: [
      collection(t, "users", users, 100),
      { ...collection(t, "posts", {}, 100), seq: 2 },
      { ...collection(t, "comments", { references: [{ name: "post", path: "post", collection: "posts", onDelete: "cascade" }] }, 100), seq: 3 },
      { ...collection(t, "likes", { references: [{ name: "post", path: "post", collection: "posts", onDelete: "set-null" }] }, 100), seq: 4 },
      // u1 is too young, then u2 shares u1's email: both before the check and the index existed.
      document(t, "users", 10, "u1", { email: "a", age: 10 }, 1, {}, 200),
      document(t, "users", 11, "u2", { email: "a", age: 30 }, 1, {}, 210),
      document(t, "users", 11, "u2", { email: "b", age: 30 }, 2, {}, 220),
      document(t, "users", 10, "u1", { email: "a", age: 30 }, 2, {}, 230),
      document(t, "posts", 12, "p9", {}, 1, {}, 240),
      document(t, "comments", 13, "c1", { post: "p9" }, 1, {}, 250),
      document(t, "likes", 14, "l1", { post: "p9" }, 1, {}, 260),
      // Deleting p9 on the earlier engine: its cascade and its cleared reference are events of their own.
      retractOf(13, 2, 270),
      document(t, "likes", 14, "l1", { post: null }, 2, {}, 270),
      retractOf(12, 2, 270),
    ],
  });
  try {
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.equal(report.eventsCarried, 10);
    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const documents = opened.database.forTenant(t).documents;
      assert.equal(await Effect.runPromise(documents.count({ collection: "comments" })), 0);
      assert.equal((await Effect.runPromise(documents.findById({ collection: "likes", id: "l1" }))).data.post, null);
      assert.deepEqual((await Effect.runPromise(documents.findMany({ collection: "users", orderBy: [{ path: "email" }] }))).map((d) => [d.id, d.data.email]), [["u1", "a"], ["u2", "b"]]);
      assert.deepEqual((await feedOf(opened, t)).filter((event) => event.documentId !== undefined).map((event) => [event.type, event.collection, event.documentId, event.revision]), [
        ["document.upserted", "users", "u1", 1],
        ["document.upserted", "users", "u2", 1],
        ["document.upserted", "users", "u2", 2],
        ["document.upserted", "users", "u1", 2],
        ["document.upserted", "posts", "p9", 1],
        ["document.upserted", "comments", "c1", 1],
        ["document.upserted", "likes", "l1", 1],
        ["document.deleted", "comments", "c1", 2],
        ["document.upserted", "likes", "l1", 2],
        ["document.deleted", "posts", "p9", 2],
      ], "exactly the earlier history: no retraction or clear from a cascade run again");
      // The index and the check hold from here on.
      const duplicate = await Effect.runPromiseExit(documents.insert({ collection: "users", id: "u3", data: { email: "a", age: 40 } }));
      assert.equal(Cause.squash(duplicate.cause)._tag, "UniqueViolation");
    } finally { await opened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a final state that breaks today's constraints fails, and nothing is left", async () => {
  const t = "tenant-a";
  const { root, source, input } = await fixture({
    [t]: [
      collection(t, "users", { indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] }),
      document(t, "users", 2, "u1", { email: "a" }),
      document(t, "users", 3, "u2", { email: "a" }),
    ],
  });
  try {
    const before = await listing(source);
    assert.match(await failure(migrateDataLayout(input)), /final state of Tenant "tenant-a" breaks a constraint of "users": UniqueViolation/);
    await assert.rejects(stat(input.workDirectory), "the staging is removed");
    assert.equal(await listing(source), before, "the source is untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dropped collections and earlier collections of the same name are counted, not carried", async () => {
  const t = "tenant-a";
  const { root, input } = await fixture({
    [t]: [
      { ...collection(t, "drafts", {}, 10), seq: 20 },
      document(t, "drafts", 21, "d1", {}, 1, {}, 20),
      retractOf(21, 2, 30),
      retractOf(20, 2, 30),
      { ...collection(t, "notes", {}, 40), seq: 30 },
      document(t, "notes", 31, "n1", {}, 1, {}, 50),
      retractOf(31, 2, 60),
      retractOf(30, 2, 60),
      { ...collection(t, "notes", {}, 70), seq: 40 },
      document(t, "notes", 41, "n2", {}, 1, {}, 80),
    ],
  });
  try {
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.deepEqual([report.collections, report.documents, report.eventsCarried, report.eventsOfDroppedCollections], [1, 1, 1, 4]);
    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const documents = opened.database.forTenant(t).documents;
      assert.deepEqual((await Effect.runPromise(documents.listCollections)).map((c) => c.name), ["notes"]);
      assert.deepEqual((await Effect.runPromise(documents.findMany({ collection: "notes" }))).map((d) => d.id), ["n2"]);
      assert.deepEqual((await feedOf(opened, t)).filter((event) => event.documentId !== undefined).map((event) => [event.type, event.collection, event.documentId, event.timestamp]),
        [["document.upserted", "notes", "n2", iso(80)]]);
    } finally { await opened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an inconsistent export fails before anything is swapped", async () => {
  const t = "tenant-a";
  const refused = async (events, pattern) => {
    const { root, input } = await fixture({ [t]: events });
    try {
      assert.match(await failure(migrateDataLayout(input)), pattern);
      await assert.rejects(stat(input.workDirectory), "the staging is removed");
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  await refused([collection(t, "users"), retractOf(99, 1)], /retraction of an unknown record \(seq 99\)/);
  await refused([collection(t, "users"), { ...document(t, "users", 2, "u1", {}), body: b64({ id: "u1", collection: "others", data: {}, version: 1 }) }], /names another collection or id/);
  await refused([collection(t, "users"), { ...document(t, "users", 2, "u1", {}), body: b64({ id: "u1", collection: "users", data: {} }) }], /has no version/);
  await refused([collection(t, "users"), document(t, "users", 2, "u1", {}, 3), document(t, "users", 2, "u1", {}, 2)], /could not be replayed: DocumentConflict/);
});

test("an export file that is short, oversized or another Tenant's is refused", async () => {
  // The reader's own bounds, against a stand-in export worker: the migration runs whatever compiled worker it is given.
  const refused = async (lines, pattern) => {
    const { root, input } = await fixture({});
    try {
      const worker = join(root, "stand-in-worker.mjs");
      await writeFile(worker, `
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"; import { join } from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "t.ndjson"), readFileSync(${JSON.stringify(join(root, "t.ndjson"))}));
writeFileSync(join(out, "manifest.json"), JSON.stringify({ format: "zelavis-data-export/2", tenants: [{ tenant: "t", file: "t.ndjson", events: 3, history: "log" }] }));
`);
      await writeFile(join(root, "t.ndjson"), lines.join("\n") + "\n");
      assert.match(await failure(migrateDataLayout({ ...input, exportWorker: worker })), pattern);
      await assert.rejects(stat(input.workDirectory), "the staging is removed");
    } finally { await rm(root, { recursive: true, force: true }); }
  };
  const header = (tenant) => JSON.stringify({ tenant, history: "log", events: 3 });
  const line = (event) => JSON.stringify(event);
  await refused([header("t"), line(collection("t", "users")), line(document("t", "users", 2, "u1", {}))], /is incomplete: 2 of 3 events/);
  await refused([header("t"), "x".repeat(64 * 1024 * 1024 + 1)], /has a line over 67108864 characters/);
  await refused([header("u")], /has a header for "u"/);
  await refused([header("t"), "{ not json"], /has an event that cannot be read \(line 2\)/);
});

test("a carried document is inserted at its version and times, and a malformed carry refuses the whole batch", async () => {
  const { CARRY_DOCUMENTS } = await import("../dist/db/document-writes.js");
  const root = await mkdtemp(join(tmpdir(), "zelavis-carry-"));
  const opened = await openNodeDatabase({ directory: join(root, "shards") });
  try {
    const documents = opened.database.forTenant("tenant-a").documents;
    await Effect.runPromise(documents.createCollection({ name: "notes", surface: "database" }));
    const insert = (id) => ({ _tag: "Insert", collection: "notes", id, data: { id } });
    await Effect.runPromise(documents.write({
      operations: [insert("n1"), insert("n2")],
      [CARRY_DOCUMENTS]: [{ version: 7, createdAt: CREATED, updatedAt: UPDATED }, undefined],
    }));
    const n1 = await Effect.runPromise(documents.findById({ collection: "notes", id: "n1" }));
    assert.deepEqual([n1.version, n1.createdAt, n1.updatedAt], [7, CREATED, UPDATED]);
    assert.equal((await Effect.runPromise(documents.findById({ collection: "notes", id: "n2" }))).version, 1, "an operation with no carried entry inserts as usual");

    for (const carry of [[{ version: 0, createdAt: CREATED, updatedAt: UPDATED }], [{ version: 2, createdAt: "yesterday", updatedAt: UPDATED }], []]) {
      const exit = await Effect.runPromiseExit(documents.write({ operations: [insert("n3")], [CARRY_DOCUMENTS]: carry }));
      assert.ok(Exit.isFailure(exit) && Cause.hasDies(exit.cause), `refused: ${JSON.stringify(carry)}`);
    }
    assert.equal(await Effect.runPromise(documents.count({ collection: "notes" })), 2, "nothing of a refused batch is written");
  } finally { await opened.close(); await rm(root, { recursive: true, force: true }); }
});
