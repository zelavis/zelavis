// The Platform's identity database: a private zelavis/db instance for Platform users' Auth data, opened beside the
// System Store, no route and no service reaching it, one component of the Platform's one backups host, restored only
// host-locally with the Platform stopped.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { identityDatabaseOf } from "../dist/platform/identity-database.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
// Platforms close before their directories go: a database is closed before its directory is removed.
const cleanups = new WeakMap();
const later = (t, step) => {
  if (!cleanups.has(t)) { cleanups.set(t, []); t.after(async () => { for (const run of cleanups.get(t).reverse()) await run(); }); }
  cleanups.get(t).push(step);
};
const scratch = (t, name) => { const d = mkdtempSync(join(tmpdir(), name)); later(t, () => rmSync(d, { recursive: true, force: true })); return d; };
const startPlatform = (t, data) => {
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false, terminal: false }) });
  later(t, () => zv.close());
  return zv;
};
const clientOf = (zv) => createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: owner }) });

test("a Platform opens its identity database privately and closes it on shutdown", async (t) => {
  const data = scratch(t, "zv-identity-db-");
  const zv = startPlatform(t, data);
  const runtime = await zv.runtime();
  assert.ok(existsSync(join(data, "identity-database", "shards")), "the database lives beside the System Store");
  assert.ok(identityDatabaseOf(runtime), "the runtime keeps it for Auth");
  assert.equal(runtime.database, undefined, "it is not the runtime's database");

  const config = await (await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/config"), { principal: owner })).json();
  assert.equal(config.capabilities.database.available, false, "runtime/config does not report it");
  assert.equal((await zv.fetch(new Request("http://localhost/zelavis/api/v1/database/tenants"), { principal: owner })).status, 404, "no /database routes on the Platform");

  const api = identityDatabaseOf(runtime);
  await api.forTenant("t1").documents.createCollection({ name: "markers" });
  await zv.close();
  // Closed: a second open of the same directory succeeds only when the first released it.
  const again = startPlatform(t, data);
  const reopened = identityDatabaseOf(await again.runtime());
  assert.equal((await reopened.forTenant("t1").documents.count("markers")), 0);
  await again.close();
});

test("a Platform backup run holds the identity, system-store and services database components", async (t) => {
  const data = scratch(t, "zv-identity-db-"), offsite = scratch(t, "zv-identity-db-offsite-");
  const zv = startPlatform(t, data);
  const client = clientOf(zv);
  const schedule = await client.runtime.backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 3, target: { kind: "directory", path: offsite } });
  const run = await client.runtime.backups.run("platform");
  assert.equal(run.status, "ok", run.error);
  assert.ok(existsSync(join(data, "backups")), "one backups host for the Platform");
  assert.ok(!existsSync(join(data, "identity-database", "backups")), "no second backups host");
  const restored = await client.runtime.backups.restore({ schedule: "platform", runId: run.runId, recoveryKey: schedule.recoveryKey });
  assert.deepEqual(readdirSync(restored.restoredTo).sort(), ["database", "identity", "system-store"]);
});

test("restore replaces the identity database host-locally, only with the Platform stopped and confirmed", async (t) => {
  const { runIdentityDatabaseCommand } = await import("../dist/cli/identity-database.js");
  const data = scratch(t, "zv-identity-db-"), offsite = scratch(t, "zv-identity-db-offsite-");
  const printed = async (args) => {
    const original = console.log, lines = [];
    console.log = (line) => lines.push(String(line));
    try { await runIdentityDatabaseCommand(args); } finally { console.log = original; }
    return lines.join("\n");
  };

  const first = startPlatform(t, data);
  const api = identityDatabaseOf(await first.runtime());
  await api.forTenant("t1").documents.createCollection({ name: "markers" });
  await api.forTenant("t1").documents.insert({ collection: "markers", id: "before", data: { n: 1 } });
  const client = clientOf(first);
  const schedule = await client.runtime.backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 3, target: { kind: "directory", path: offsite } });
  const run = await client.runtime.backups.run("platform");
  assert.equal(run.status, "ok", run.error);
  const restored = await client.runtime.backups.restore({ schedule: "platform", runId: run.runId, recoveryKey: schedule.recoveryKey });
  const component = join(restored.restoredTo, "identity");
  await api.forTenant("t1").documents.insert({ collection: "markers", id: "after", data: { n: 2 } });

  // Refused while the Platform runs, and without the confirmation.
  await assert.rejects(() => runIdentityDatabaseCommand(["restore", component, "--confirm", "restore", "--data-dir", data]), /running|owned|Platform/i);
  await first.close();
  await assert.rejects(() => runIdentityDatabaseCommand(["restore", component, "--data-dir", data]), /--confirm restore/);

  const result = JSON.parse(await printed(["restore", component, "--confirm", "restore", "--data-dir", data, "--json"]));
  assert.equal(result.restored, true);
  assert.ok(existsSync(result.replacedPath), "the replaced database is kept");
  assert.ok(readdirSync(join(data, "identity-database")).some((name) => name.startsWith("shards.replaced-")));

  const second = startPlatform(t, data);
  const reopened = identityDatabaseOf(await second.runtime());
  const markers = reopened.forTenant("t1").documents;
  assert.equal((await markers.findById({ collection: "markers", id: "before" })).data.n, 1, "the backed-up marker is back");
  assert.equal(await markers.findById({ collection: "markers", id: "after" }), undefined, "what came after the backup is not");
});
