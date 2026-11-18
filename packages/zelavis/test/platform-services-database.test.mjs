import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runServicesDatabaseCommand } from "../dist/cli/services-database.js";
import { openNodeDatabase } from "../dist/db/node-host.js";

const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const cleanups = new WeakMap();
const later = (t, cleanup) => {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(async () => { for (const run of cleanups.get(t).reverse()) await run(); });
  }
  cleanups.get(t).push(cleanup);
};
const scratch = (t, prefix = "zv-services-db-") => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  later(t, () => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const startPlatform = (t, data, service) => {
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: service ? { catalog: [{ service, status: "installed", source: "official", order: 0 }] } : false, projects: {}, terminal: false }) });
  later(t, () => zv.close());
  return zv;
};

test("a Platform opens the services shards without a second backups host and releases them on close", async (t) => {
  const data = scratch(t);
  const zv = startPlatform(t, data);
  await zv.runtime();
  const directory = join(data, "services-database", "shards");
  assert.ok(existsSync(directory));
  assert.equal(existsSync(join(data, "services-database", "backups")), false);
  await zv.close();
  const reopened = await openNodeDatabase({ directory, backups: false });
  try {
    assert.equal(reopened.backups, undefined);
    await assert.rejects(() => reopened.api.backups.createSchedule({}), /cannot run scheduled backups/i);
  } finally { await reopened.close(); }
});

const databaseService = (setup) => ({ name: "@test/records", kind: "plugin", namespace: "records", setup });
const request = (zv, path, init) => zv.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, init), { principal: owner });

test("only services receive the private database; Platform routes and environment persistence remain unavailable", async (t) => {
  let database;
  const data = scratch(t);
  const zv = startPlatform(t, data, databaseService((context) => { database = context.core.database; }));
  const runtime = await zv.runtime();
  assert.equal(typeof database?.forTenant, "function");
  assert.equal(runtime.database, undefined);
  const config = await (await request(zv, "/runtime/config")).json();
  assert.equal(config.capabilities.database.available, false);
  assert.equal((await request(zv, "/database/tenants")).status, 404);
  const response = await request(zv, "/runtime/environment/sessions/session-1", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Environment session persistence is unavailable." });
  const documents = database.forTenant("service:@test/records").documents;
  await documents.createCollection({ name: "images" });
  await database.images.create("services-proof");
  assert.ok(existsSync(join(data, "services-database", "images", "services-proof")));
  await zv.close();
  await assert.rejects(() => documents.insert({ collection: "images", id: "closed", data: { n: 1 } }));
});

const clientOf = (zv) => createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: owner }) });
const cli = (data, source, extra = ["--confirm", "restore"]) => spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "services-database", "restore", source, "--data-dir", data, ...extra], { encoding: "utf8", timeout: 15_000 });

test("Platform backup captures service records and host-local restore replaces them only while stopped", async (t) => {
  const data = scratch(t), offsite = scratch(t, "zv-services-offsite-");
  let database;
  const service = databaseService((context) => { database = context.core.database; });
  const first = startPlatform(t, data, service);
  await first.runtime();
  const records = database.forTenant("service:@test/records").documents;
  await records.createCollection({ name: "markers" });
  await records.insert({ collection: "markers", id: "before", data: { n: 1 } });
  const client = clientOf(first);
  const schedule = await client.runtime.backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 3, target: { kind: "directory", path: offsite } });
  const run = await client.runtime.backups.run("platform");
  assert.equal(run.status, "ok", run.error);
  await first.close();

  const second = startPlatform(t, data, service);
  await second.runtime();
  const restored = await clientOf(second).runtime.backups.restore({ schedule: "platform", runId: run.runId, recoveryKey: schedule.recoveryKey });
  assert.deepEqual(readdirSync(restored.restoredTo).sort(), ["database", "identity", "system-store"]);
  const image = join(restored.restoredTo, "database");
  await database.forTenant("service:@test/records").documents.insert({ collection: "markers", id: "after", data: { n: 2 } });
  const running = cli(data, image);
  assert.equal(running.status, 1, running.stderr);
  assert.match(running.stderr, /The Platform is running; stop it first\./);
  assert.ok(existsSync(image));
  await second.close();
  const unconfirmed = cli(data, image, []);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /--confirm restore/);
  const result = cli(data, image, ["--confirm", "restore", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.restored, true);
  assert.ok(existsSync(answer.replacedPath));
  assert.equal(existsSync(image), false, "the services component is moved into place");

  const third = startPlatform(t, data, service);
  await third.runtime();
  const markers = database.forTenant("service:@test/records").documents;
  assert.equal((await markers.findById({ collection: "markers", id: "before" })).data.n, 1);
  assert.equal(await markers.findById({ collection: "markers", id: "after" }), undefined);
});

test("restore rejects unrelated, incomplete and corrupt images without replacing current shards", async (t) => {
  const data = scratch(t), bad = scratch(t);
  let database;
  const service = databaseService((context) => { database = context.core.database; });
  const first = startPlatform(t, data, service);
  await first.runtime();
  await database.forTenant("service:@test/records").documents.createCollection({ name: "markers" });
  await database.forTenant("service:@test/records").documents.insert({ collection: "markers", id: "kept", data: { n: 7 } });
  await first.close();
  for (const shape of ["empty", "unrelated", "incomplete", "corrupt"]) {
    if (shape === "unrelated") writeFileSync(join(bad, "notes.txt"), "not a database");
    if (shape === "incomplete") writeFileSync(join(bad, "zv.topology.sqlite"), "not sqlite");
    if (shape === "corrupt") {
      writeFileSync(join(bad, "zv.global.sqlite"), "not sqlite");
      writeFileSync(join(bad, "services-0.sqlite"), "not sqlite");
    }
    const rejected = cli(data, bad);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /is not a database image\./);
    assert.ok(existsSync(join(data, "services-database", "shards")));
    assert.equal(readdirSync(join(data, "services-database")).some((name) => name.startsWith("shards.replaced-")), false);
  }
  const again = startPlatform(t, data, service);
  await again.runtime();
  assert.equal((await database.forTenant("service:@test/records").documents.findById({ collection: "markers", id: "kept" })).data.n, 7);
});

test("an interrupted restore refuses Platform startup and rerunning restore finishes it", async (t) => {
  const data = scratch(t);
  const first = startPlatform(t, data);
  const client = clientOf(first);
  const offsite = scratch(t, "zv-services-offsite-");
  const schedule = await client.runtime.backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 2, target: { kind: "directory", path: offsite } });
  const run = await client.runtime.backups.run("platform");
  const restored = await client.runtime.backups.restore({ schedule: "platform", runId: run.runId, recoveryKey: schedule.recoveryKey });
  await first.close();
  renameSync(join(data, "services-database", "shards"), join(data, "services-database", "shards.replaced-1"));
  const interrupted = startPlatform(t, data);
  await assert.rejects(() => interrupted.runtime(), /An interrupted services-database restore needs finishing: run zelavis services-database restore again\./);
  await interrupted.close();
  assert.equal(existsSync(join(data, "services-database", "shards")), false);
  const result = cli(data, join(restored.restoredTo, "database"), ["--confirm", "restore", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).replacedPath, null);
  const again = startPlatform(t, data);
  await again.runtime();
  assert.ok(existsSync(join(data, "services-database", "shards")));
});

test("a failed image move rolls back the current shards and releases maintenance ownership", async (t) => {
  const data = scratch(t), offsite = scratch(t, "zv-services-offsite-");
  const first = startPlatform(t, data);
  const client = clientOf(first);
  const schedule = await client.runtime.backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 2, target: { kind: "directory", path: offsite } });
  const run = await client.runtime.backups.run("platform");
  const restored = await client.runtime.backups.restore({ schedule: "platform", runId: run.runId, recoveryKey: schedule.recoveryKey });
  await first.close();
  const image = join(restored.restoredTo, "database"), target = join(data, "services-database", "shards");
  const original = fs.rename;
  const renames = [];
  const mocked = t.mock.method(fs, "rename", async (from, to) => {
    renames.push([from, to]);
    if (from === image) throw Object.assign(new Error("injected image move failure"), { code: "EXDEV" });
    return original(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => runServicesDatabaseCommand(["restore", image, "--data-dir", data, "--confirm", "restore"]), /injected image move failure/);
    assert.equal(renames.filter(([from]) => from === target).length, 1, "the previous database moved aside");
    assert.equal(renames.filter(([, to]) => to === target).length, 2, "failed replacement was followed by rollback");
    assert.ok(existsSync(target));
    assert.ok(existsSync(image));
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const again = startPlatform(t, data);
  await again.runtime();
});

test("an unopenable services database fails startup with its own error and releases partial resources", async (t) => {
  const data = scratch(t), directory = join(data, "services-database", "shards");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "zv.topology.sqlite"), "not sqlite");
  const failed = startPlatform(t, data);
  await assert.rejects(() => failed.runtime(), (error) => {
    assert.equal(error._tag, "StoreError");
    assert.equal(error.op, "node-sqlite.open");
    return true;
  });
  await failed.close();
  rmSync(directory, { recursive: true });
  const again = startPlatform(t, data);
  await again.runtime();
});
