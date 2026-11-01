import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit, Cause } from "effect";
import { migrateDataLayout } from "../dist/adapters/_node-data-migration.js";
import { openNodeDatabase } from "../dist/db/node-host.js";

// The earlier engine is replaced by a stand-in release tree whose database "opens" whatever `fake.json` in the shard
// directory says it holds. That exercises the real worker process, the export files, recreation and verification; the
// earlier engine's real layout is covered by distribution/scripts/format-migration/harness.mjs against alpha.42.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
const collection = (tenant, name, extra = {}) => ({ kind: "put", seq: 1, version: 1, at: 0, identity: { namespace: `zv.collection/${tenant}`, key: name }, body: b64({ name, surface: "database", ...extra }) });
const document = (tenant, name, seq, id, data, version = 1) => ({ kind: "put", seq, version, at: 0, identity: { namespace: `doc/${tenant}/${name}`, key: id }, body: b64({ id, collection: name, data, version }) });

async function earlierRelease(root, crash) {
  const platform = join(root, "platform");
  await mkdir(join(platform, "dist", "db"), { recursive: true });
  await mkdir(join(platform, "node_modules", "effect", "dist"), { recursive: true });
  await writeFile(join(platform, "node_modules", "effect", "package.json"), JSON.stringify({ name: "effect", type: "module" }));
  await writeFile(join(platform, "node_modules", "effect", "dist", "index.js"), "export const Effect = { runPromise: async (program) => (typeof program === 'function' ? program() : program) };\n");
  await writeFile(join(platform, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(platform, "dist", "db", "node-host.js"), `
import { readFile } from "node:fs/promises"; import { join } from "node:path";
export const openNodeDatabase = async ({ directory }) => {
  ${crash ? 'throw new Error("earlier engine crashed while opening");' : ""}
  const fake = JSON.parse(await readFile(join(directory, "fake.json"), "utf8"));
  return { close: async () => {}, database: { tenants: () => Object.keys(fake), forTenant: (tenant) => ({ backups: { exportTenant: () => ({ events: fake[tenant] }) } }) } };
};\n`);
  return platform;
}

async function fixture(contents, { crash = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-data-migration-"));
  const source = join(root, "old-shards");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "fake.json"), JSON.stringify(contents));
  const oldPlatform = await earlierRelease(join(root, "old-release"), crash);
  const input = { sourceShards: source, workDirectory: join(root, "work"), oldNode: process.execPath, oldPlatform, exportWorker: new URL("../dist/adapters/_data-export-worker.js", import.meta.url).pathname };
  return { root, source, input };
}
const listing = async (dir) => (await readdir(dir)).sort().join(",");
const failure = async (effect) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected the migration to fail");
  return String(Cause.squash(exit.cause).message ?? Cause.squash(exit.cause));
};

test("a database written by an earlier layout is recreated through the documents API, verified, and its history restarts", async () => {
  const t = "tenant-a";
  const { root, source, input } = await fixture({
    [t]: [
      collection(t, "users", { indexes: [{ name: "by_email", fields: [{ path: "email" }], unique: true }] }),
      { ...collection(t, "posts"), seq: 2 },
      document(t, "users", 3, "u1", { email: "a@x.test", age: 30 }),
      document(t, "users", 4, "u2", { email: "b@x.test", age: 40 }, 3),
      document(t, "posts", 5, "p1", { title: "hello" }),
      document(t, "posts", 6, "p2", { title: "gone" }),
      { kind: "retract", seq: 6, version: 2, at: 0 },
      { kind: "put", seq: 7, version: 1, at: 0, identity: { namespace: `zv.idempotency/${t}`, key: "key-1" }, body: b64({ done: true }) },
      { kind: "put", seq: 8, version: 1, at: 0, identity: { namespace: "zv.schema", key: `${t}/posts/1` }, body: b64({ collection: "posts", version: 1, active: true, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: false } }] }) },
      { kind: "put", seq: 9, version: 1, at: 0, identity: { namespace: "zv.schema", key: `${t}/posts/2` }, body: b64({ collection: "posts", version: 2, active: false, fields: [{ name: "title", field: { _tag: "TextField", label: "Title", required: true } }] }) },
      { kind: "put", seq: 10, version: 1, at: 0, identity: { namespace: "zv.schema.active", key: `${t}/posts` }, body: b64({ version: 1 }) },
    ],
    "tenant-empty": [],
  });
  try {
    const before = await readFile(join(source, "fake.json"), "utf8");
    const report = await Effect.runPromise(migrateDataLayout(input));
    assert.equal(report.tenants, 2);
    assert.equal(report.collections, 2);
    assert.equal(report.schemas, 2, "every saved schema version is recreated");
    assert.equal(report.documents, 3, "the retracted post is not carried");
    assert.equal(report.documentsWithHistoryDropped, 1, "u2 had been updated");
    assert.deepEqual(report.dropped, { "zv.idempotency": 1 });
    assert.equal(await readFile(join(source, "fake.json"), "utf8"), before, "the source is never written");

    const opened = await openNodeDatabase({ directory: report.shardsDirectory });
    try {
      const documents = opened.database.forTenant(t).documents;
      assert.deepEqual((await Effect.runPromise(documents.findMany({ collection: "users", orderBy: [{ path: "email" }] }))).map((d) => [d.id, d.data.age]), [["u1", 30], ["u2", 40]]);
      assert.equal(await Effect.runPromise(documents.count({ collection: "posts" })), 1);
      assert.equal((await Effect.runPromise(documents.findById({ collection: "users", id: "u2" }))).version, 1, "versions restart");
      const eq = await Effect.runPromise(documents.findMany({ collection: "users", where: [{ path: "email", op: "eq", value: "b@x.test" }] }));
      assert.deepEqual(eq.map((d) => d.id), ["u2"], "the recreated index answers");
      const versions = await Effect.runPromise(opened.database.forTenant(t).schemas.listVersions("posts"));
      assert.deepEqual(versions.map((v) => [v.version, v.active]), [[1, true], [2, false]], "the active schema stays the active one");
    } finally { await opened.close(); }
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
