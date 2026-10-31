// The Platform's own backups: its System Store captured as records, encrypted off the host, restored to a file
// and imported into a stopped Platform's store, through the routes, the SDK and the CLI alike.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit, Scope } from "effect";
import { writeFile } from "node:fs/promises";
import { backupsHost } from "../dist/db/node-backups.js";
import { InvalidBackup } from "../dist/db/errors.js";
import { platformBackupRoutes, systemStoreComponent } from "../dist/platform/platform-backups.js";
import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";
import { runSystemStoreCommand } from "../dist/cli/system-store.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runBackupsCommand } from "../dist/cli/backups.js";

const scratch = (t, name) => { const d = mkdtempSync(join(tmpdir(), name)); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const writeLines = (path, lines) => Effect.tryPromise({ try: () => writeFile(path, lines.length ? `${lines.join("\n")}\n` : ""), catch: (cause) => new InvalidBackup({ reason: String(cause) }) });

const platform = async (t) => {
  const data = scratch(t, "zv-platform-"), offsite = scratch(t, "zv-platform-offsite-");
  const store = createLocalSqliteSystemStore({ filename: join(data, "system", "zelavis.sqlite") });
  await store.set("platform", "master-secret", "s3cr3t");
  await store.set("zelavis.platform.projects", "p1", { id: "p1", name: "Shop" });
  const scope = await Effect.runPromise(Scope.make());
  t.after(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); store.close?.(); });
  const backups = await Effect.runPromise(backupsHost({ directory: join(data, "backups"), components: [systemStoreComponent(store, writeLines)], scope }));
  return { data, offsite, store, backups };
};

test("the System Store is backed up encrypted, restored to records, and imported only into a stopped Platform", async (t) => {
  const { offsite, backups } = await platform(t);
  const schedule = await backups.createSchedule({ name: "platform", cron: "0 4 * * *", keep: 3, target: { kind: "directory", path: offsite } });
  const run = await backups.runNow("platform");
  assert.equal(run.status, "ok", run.error);
  assert.equal((await backups.verify("platform", run.runId)).verified, true);
  const restored = await backups.restore("platform", run.runId, { recoveryKey: schedule.recoveryKey });
  const file = join(restored.restoredTo, "system-store", "records.jsonl");

  const fresh = scratch(t, "zv-platform-fresh-");
  await assert.rejects(() => runSystemStoreCommand(["import", file, "--data-dir", fresh]), /--confirm import/);
  await runSystemStoreCommand(["import", file, "--data-dir", fresh, "--confirm", "import"]);
  const imported = createLocalSqliteSystemStore({ filename: join(fresh, "system", "zelavis.sqlite") });
  try {
    assert.equal((await imported.get("platform", "master-secret")).value, "s3cr3t", "the master secret comes back with the store");
    assert.deepEqual((await imported.get("zelavis.platform.projects", "p1")).value, { id: "p1", name: "Shop" });
  } finally { imported.close?.(); }
  await assert.rejects(() => runSystemStoreCommand(["import", file, "--data-dir", fresh, "--confirm", "import"]), /--replace/);
  await runSystemStoreCommand(["import", file, "--data-dir", fresh, "--confirm", "import", "--replace"]);
});

test("Platform backups come out the same through the routes, the SDK and the CLI", async (t) => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const { offsite, backups } = await platform(t);
    const routes = platformBackupRoutes({ apiPrefix: "/zelavis/api", apiVersion: "v1", backups });
    const dispatch = async (method, path, body) => {
      for (const route of routes) {
        if (route.method !== method) continue;
        const names = [];
        const match = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return "([^/]+)"; })}$`).exec(path.split("?")[0]);
        if (!match) continue;
        const answer = await route.handler({ params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])), body, query: new URL(`http://x${path}`).searchParams });
        return answer;
      }
      throw new Error(`no route ${method} ${path}`);
    };
    const fetch = async (input, init) => {
      const url = new URL(String(input));
      const answer = await dispatch(init?.method ?? "GET", url.pathname + url.search, init?.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    };
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch });
    const cli = async (args) => {
      const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
      globalThis.fetch = fetch; console.log = (line) => lines.push(String(line));
      try { await runBackupsCommand([...args, "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
      return JSON.parse(lines.join("\n"));
    };
    const input = { name: "platform", cron: "0 4 * * *", keep: 2, target: { kind: "directory", path: offsite } };
    const forms = {
      http: { create: async () => (await dispatch("POST", "/zelavis/api/v1/runtime/backups/schedules", input)).body, run: async () => (await dispatch("POST", "/zelavis/api/v1/runtime/backups/schedules/platform/run", {})).body, runs: async () => (await dispatch("GET", "/zelavis/api/v1/runtime/backups/runs")).body.runs },
      sdk: { create: () => client.runtime.backups.createSchedule(input), run: () => client.runtime.backups.run("platform"), runs: () => client.runtime.backups.runs() },
      cli: { create: () => cli(["create-schedule", "--data", JSON.stringify(input)]), run: () => cli(["run", "platform"]), runs: async () => (await cli(["runs"])).runs },
    }[surface];
    const created = await forms.create();
    const run = await forms.run();
    results[surface] = { key: typeof created.recoveryKey, run: run.status, runs: (await forms.runs()).map((entry) => entry.status) };
  }
  assert.deepEqual(results.http, { key: "string", run: "ok", runs: ["ok"] });
  assert.deepEqual(results.sdk, results.http);
  assert.deepEqual(results.cli, results.http);
});
