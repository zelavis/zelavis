// Scheduled, encrypted, off-site backups: a schedule probes its target and hands out its key once; a run is an
// image packed, encrypted in sealed parts and published by its manifest; retention keeps the newest runs; verify
// detects a changed part; restore needs the right key and gives back a database that opens.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNodeDatabase } from "../dist/db/node-host.js";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";

const scratch = (t, name) => {
  const directory = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const filesUnder = (root) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

test("a schedule's runs are encrypted at the target, kept to its retention, verified, and restored with its key", async (t) => {
  const root = scratch(t, "zv-backups-"), offsite = scratch(t, "zv-offsite-");
  const opened = await openNodeDatabase({ directory: join(root, "primary", "shards"), crossTenantRefresh: false });
  t.after(() => opened.close());
  const acme = opened.api.forTenant("acme");
  await acme.documents.createCollection({ name: "posts" });
  await acme.documents.insert({ collection: "posts", id: "secret", data: { title: "a sentence nobody off-site may read" } });
  const backups = opened.api.backups;

  await assert.rejects(() => backups.createSchedule({ name: "bad", cron: "every day", keep: 1, target: { kind: "directory", path: offsite } }), /not a cron expression/);
  await assert.rejects(() => backups.createSchedule({ name: "bad", cron: "0 3 * * *", keep: 0, target: { kind: "directory", path: offsite } }), /keep is a whole number/);
  const schedule = await backups.createSchedule({ name: "nightly", cron: "0 3 * * *", keep: 2, target: { kind: "directory", path: offsite } });
  assert.match(schedule.recoveryKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(schedule.keyFingerprint.length, 16);
  assert.ok(schedule.nextRunAt > new Date().toISOString());
  await assert.rejects(() => backups.createSchedule({ name: "nightly", cron: "0 3 * * *", keep: 2, target: { kind: "directory", path: offsite } }), /already exists/);
  const listed = await backups.schedules();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].recoveryKey, undefined, "the key is answered once");

  const runs = [];
  for (let n = 0; n < 3; n++) runs.push(await backups.runNow("nightly"));
  assert.ok(runs.every((run) => run.status === "ok" && run.parts >= 1 && run.bytes > 0), JSON.stringify(runs));
  const manifests = filesUnder(offsite).filter((file) => file.endsWith("manifest.json"));
  assert.equal(manifests.length, 2, "retention keeps the newest two runs");
  for (const file of filesUnder(offsite).filter((file) => !file.endsWith(".json") && !file.includes(".probe"))) {
    assert.ok(!readFileSync(file).includes(Buffer.from("nobody off-site")), `${file} holds nothing readable`);
  }

  const latest = runs.at(-1).runId;
  assert.equal((await backups.verify("nightly", latest)).verified, true);
  const part = filesUnder(offsite).find((file) => file.includes(latest) && file.includes("part-000000") && !file.endsWith(".json"));
  const original = readFileSync(part);
  const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1;
  writeFileSync(part, tampered);
  assert.equal((await backups.verify("nightly", latest)).verified, false, "a changed part does not verify");
  writeFileSync(part, original);

  await assert.rejects(() => backups.restore("nightly", latest, { recoveryKey: Buffer.alloc(32, 7).toString("base64url") }), /not the key this run was written with/);
  const restored = await backups.restore("nightly", latest, { recoveryKey: schedule.recoveryKey });
  assert.ok(restored.restoredTo.includes(latest));
  const copy = await openNodeDatabase({ directory: join(restored.restoredTo, "database"), crossTenantRefresh: false });
  try {
    assert.equal((await copy.api.forTenant("acme").documents.findById({ collection: "posts", id: "secret" })).data.title, "a sentence nobody off-site may read");
  } finally { await copy.close(); }
  const history = await backups.runs("nightly");
  assert.equal(history[0].runId, latest);
  assert.equal(history[0].restoredTo, restored.restoredTo);
  await backups.deleteSchedule("nightly");
  assert.deepEqual(await backups.schedules(), []);
});

test("backup schedules and runs come out the same through HTTP, the SDK and the CLI", async (t) => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const root = scratch(t, "zv-backups-p-"), offsite = scratch(t, "zv-offsite-p-");
    const opened = await openNodeDatabase({ directory: join(root, "primary", "shards"), crossTenantRefresh: false });
    t.after(() => opened.close());
    await opened.api.forTenant("acme").documents.createCollection({ name: "posts" });
    const routes = defineDatabaseService(opened.api).api.v1;
    const PROXY = "/zelavis/api/v1/runtime/projects/p1/proxy/zelavis/api/v1/database";
    const dispatch = async (method, path, body) => {
      for (const route of routes) {
        if (route.method !== method) continue;
        const names = [];
        const pattern = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return "([^/]+)"; })}$`);
        const match = pattern.exec(path);
        if (!match) continue;
        const params = Object.fromEntries(names.map((name, at) => [name, decodeURIComponent(match[at + 1])]));
        const url = new URL(`http://x${path}`);
        const answer = await route.handler({ service: opened.api, params, query: url.searchParams, body, principal: undefined, headers: {}, request: undefined });
        return { status: answer.status ?? 200, body: answer.body };
      }
      throw new Error(`no route ${method} ${path}`);
    };
    const fetch = async (input, init) => {
      const url = new URL(String(input));
      const answer = await dispatch(init?.method ?? "GET", url.pathname.slice(PROXY.length).split("?")[0], init?.body ? JSON.parse(init.body) : undefined).catch(() => dispatch(init?.method ?? "GET", url.pathname.slice(PROXY.length), init?.body ? JSON.parse(init.body) : undefined));
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    };
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch });
    const cli = async (args) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = fetch; console.log = (line) => lines.push(String(line));
      try { await runProjectsCommand([...args, "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return JSON.parse(lines.join("\n"));
    };
    const input = { name: "nightly", cron: "0 3 * * *", keep: 3, target: { kind: "directory", path: offsite } };
    const forms = {
      http: { create: async () => (await dispatch("POST", "/maintenance/backup-schedules", input)).body, list: async () => (await dispatch("GET", "/maintenance/backup-schedules")).body.schedules, run: async () => (await dispatch("POST", "/maintenance/backup-schedules/nightly/run", {})).body, runs: async () => (await dispatch("GET", "/maintenance/backup-runs")).body.runs },
      sdk: { create: () => client.projects.createBackupSchedule("p1", input), list: () => client.projects.backupSchedules("p1"), run: () => client.projects.runBackup("p1", "nightly"), runs: () => client.projects.backupRuns("p1") },
      cli: { create: async () => (await cli(["create-backup-schedule", "p1", "--data", JSON.stringify(input)])).schedule, list: async () => (await cli(["backup-schedules", "p1"])).schedules, run: async () => (await cli(["run-backup", "p1", "nightly"])).run, runs: async () => (await cli(["backup-runs", "p1"])).runs },
    }[surface];
    const created = await forms.create();
    const run = await forms.run();
    results[surface] = {
      key: typeof created.recoveryKey === "string",
      listed: (await forms.list()).map(({ name, cron, keep, target }) => ({ name, cron, keep, kind: target.kind })),
      run: run.status,
      runs: (await forms.runs()).map((entry) => entry.status),
    };
  }
  assert.deepEqual(results.http, { key: true, listed: [{ name: "nightly", cron: "0 3 * * *", keep: 3, kind: "directory" }], run: "ok", runs: ["ok"] });
  assert.deepEqual(results.sdk, results.http);
  assert.deepEqual(results.cli, results.http);
});

test("a schedule runs on its own at its times, and again after the database reopens", async (t) => {
  const root = scratch(t, "zv-backups-cron-"), offsite = scratch(t, "zv-offsite-cron-");
  const directory = join(root, "primary", "shards");
  const first = await openNodeDatabase({ directory, crossTenantRefresh: false });
  await first.api.forTenant("acme").documents.createCollection({ name: "posts" });
  await first.api.backups.createSchedule({ name: "often", cron: "* * * * * *", keep: 50, drillAfterRun: true, target: { kind: "directory", path: offsite } });
  const waitForRuns = async (api, count) => {
    for (let tries = 0; tries < 100; tries++) {
      if ((await api.backups.runs("often")).filter((run) => run.status === "ok").length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`fewer than ${count} scheduled runs`);
  };
  await waitForRuns(first.api, 1);
  for (let tries = 0; tries < 50 && !(await first.api.backups.runs("often")).some((run) => run.drill?.ok); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok((await first.api.backups.runs("often")).some((run) => run.drill?.ok === true), "a scheduled run is drilled after it is made");
  await first.close();
  const second = await openNodeDatabase({ directory, crossTenantRefresh: false });
  t.after(() => second.close());
  const counted = (await second.api.backups.runs("often")).filter((run) => run.status === "ok").length;
  await waitForRuns(second.api, counted + 1);
});

test("a Project's run carries its runtime store, copied consistently while open, and its media files", async (t) => {
  const { backupsHost, sqliteFileComponent, directoryComponent } = await import("../dist/db/node-backups.js");
  const { Effect, Exit, Scope } = await import("effect");
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdirSync, existsSync } = await import("node:fs");
  const root = scratch(t, "zv-project-backup-"), offsite = scratch(t, "zv-project-offsite-");
  const runtimeFile = join(root, "runtime", "zelavis.sqlite");
  mkdirSync(join(root, "runtime"), { recursive: true });
  const live = new DatabaseSync(runtimeFile);
  live.exec("PRAGMA journal_mode = WAL; CREATE TABLE workloads (id TEXT); INSERT INTO workloads VALUES ('nightly-job');");
  mkdirSync(join(root, "files", "uploads"), { recursive: true });
  writeFileSync(join(root, "files", "uploads", "logo.png"), Buffer.from([1, 2, 3]));
  const scope = await Effect.runPromise(Scope.make());
  t.after(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); live.close(); });
  const backups = await Effect.runPromise(backupsHost({ directory: join(root, "backups"), scope, components: [sqliteFileComponent("runtime", runtimeFile), directoryComponent("media", join(root, "files"))] }));
  const schedule = await backups.createSchedule({ name: "project", cron: "0 3 * * *", keep: 2, target: { kind: "directory", path: offsite } });
  const run = await backups.runNow("project");
  assert.equal(run.status, "ok", run.error);
  const restored = await backups.restore("project", run.runId, { recoveryKey: schedule.recoveryKey });
  const copy = new DatabaseSync(join(restored.restoredTo, "runtime", "store.sqlite"), { readOnly: true });
  try { assert.deepEqual(copy.prepare("SELECT id FROM workloads").all().map((row) => row.id), ["nightly-job"], "the open WAL store was copied whole"); }
  finally { copy.close(); }
  assert.deepEqual([...readFileSync(join(restored.restoredTo, "media", "uploads", "logo.png"))], [1, 2, 3]);
  assert.ok(existsSync(join(restored.restoredTo, "runtime")));
});

test("a restore drill restores the newest run into a fresh directory, opens it, and records RTO and RPO", async (t) => {
  const root = scratch(t, "zv-drill-"), offsite = scratch(t, "zv-drill-offsite-");
  const opened = await openNodeDatabase({ directory: join(root, "primary", "shards"), crossTenantRefresh: false });
  t.after(() => opened.close());
  for (const tenant of ["acme", "globex"]) {
    await opened.api.forTenant(tenant).documents.createCollection({ name: "posts" });
    for (const id of ["a", "b"]) await opened.api.forTenant(tenant).documents.insert({ collection: "posts", id, data: { id } });
  }
  const backups = opened.api.backups;
  await backups.createSchedule({ name: "drilled", cron: "0 3 * * *", keep: 3, target: { kind: "directory", path: offsite } });
  await assert.rejects(() => backups.drill("drilled"), /no finished run to drill/);
  const run = await backups.runNow("drilled");
  const drilled = await backups.drill("drilled");
  assert.equal(drilled.runId, run.runId);
  assert.equal(drilled.drill.ok, true, drilled.drill.error);
  assert.ok(drilled.drill.rtoMs >= 0 && drilled.drill.rpoMs >= 0);
  assert.equal(drilled.drill.tenants, 2);
  assert.ok(drilled.drill.records > 0);
  assert.deepEqual(readdirSync(join(root, "primary", "backups", "drills")), [], "the drill's copy is removed");
  assert.equal((await opened.api.forTenant("acme").documents.findMany({ collection: "posts" })).length, 2, "the live database is untouched");
  // A run whose parts were damaged fails its drill, and says why.
  const part = filesUnder(offsite).find((file) => file.includes(run.runId) && file.includes("part-000000") && !file.endsWith(".json"));
  writeFileSync(part, Buffer.from("not a sealed part"));
  const failed = await backups.drill("drilled", run.runId);
  assert.equal(failed.drill.ok, false);
  assert.match(failed.drill.error, /decrypt/);
});
