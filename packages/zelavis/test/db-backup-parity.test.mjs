// Tenant backup export and restore through the JS API, the HTTP route, the SDK
// and the CLI: one scenario run through each, every one against a real
// database of its own, has to come out the same — the same backups, the same
// restore results, the same refusals and the same data left behind.
//
// The SDK and the CLI reach the route the way they do on a Platform, through
// the Project proxy; the fake Platform here hands that request to the
// database service's own route handler, so nothing in between answers for it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineDatabaseService } from "../dist/db/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { openTemporaryDatabase } from "./_database.mjs";

/** An operator holding what `project.runtime.manage` and `project.view` forward. */
const operator = {
  id: "operator",
  type: "user",
  permissions: ["database.inspect", "database.read", "database.write", "database.backup", "database.restore"],
};

const BASE = "http://zv.test/zelavis";
const BACKUP_PATH = /^\/zelavis\/api\/v1\/runtime\/projects\/p1\/proxy\/zelavis\/api\/v1\/database\/maintenance\/backups\/(export|restore)$/;

const routeOf = (api, id) => {
  const found = defineDatabaseService(api).api.v1.find((route) => route.id === id);
  assert.ok(found, `route ${id} should exist`);
  return found;
};

/** The HTTP route itself: what a request with this body gets back. */
const route = async (api, action, body, principal = operator) => {
  const response = await routeOf(api, `database.backups.${action}`).handler({
    service: api, params: {}, query: new URLSearchParams(), body, principal, headers: {}, request: undefined,
  });
  return { status: response.status ?? 200, body: response.body };
};

/** A Platform whose Project proxy reaches `api`'s backup routes and nothing else. */
const platform = (api, requests, principal = operator) => async (input, init) => {
  const url = new URL(String(input));
  const match = BACKUP_PATH.exec(url.pathname);
  assert.ok(match, `unexpected request ${init?.method} ${url.pathname}`);
  assert.equal(init?.method, "POST");
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  requests?.push({ action: match[1], body });
  const answer = await route(api, match[1], body, principal);
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
};

const refusalOf = (error) => ({ refused: error?._tag ?? error?.message ?? String(error) });

/** The four ways to back up and restore a Tenant, each bound to one database. */
const surfaces = {
  js: (api) => ({
    export: (tenantId) => api.forTenant(tenantId).backups.exportTenant(),
    restore: (backup, options = {}) =>
      api.forTenant(options.tenantId ?? backup.tenantId).backups.restoreTenant(backup, options.into === undefined ? undefined : { into: options.into }),
  }),
  http: (api) => {
    const answered = async (action, body) => {
      const answer = await route(api, action, body);
      if (answer.status !== 200) throw Object.assign(new Error(answer.body.error), { status: answer.status });
      return answer.body;
    };
    return {
      export: (tenantId) => answered("export", { tenantId }),
      restore: (backup, options = {}) => answered("restore", { backup, ...options }),
    };
  },
  sdk: (api) => {
    const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api) });
    return {
      export: (tenantId) => client.projects.exportTenant("p1", { tenantId }),
      restore: (backup, options) => client.projects.restoreTenant("p1", backup, options),
    };
  },
  cli: (api, t) => {
    const directory = mkdtempSync(join(tmpdir(), "zv-backup-cli-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    /** Runs one command against `api`, handing back what it printed. */
    const cli = async (args) => {
      const originalFetch = globalThis.fetch;
      const originalLog = console.log;
      const lines = [];
      globalThis.fetch = platform(api);
      console.log = (line) => lines.push(String(line));
      try {
        await runProjectsCommand([...args, "--url", BASE]);
      } finally {
        globalThis.fetch = originalFetch;
        console.log = originalLog;
      }
      return lines.join("\n");
    };
    let files = 0;
    return {
      export: async (tenantId) => {
        const file = join(directory, `export-${files++}.json`);
        await cli(["export-tenant", "p1", "--tenant", tenantId, "--output", file]);
        return JSON.parse(readFileSync(file, "utf8"));
      },
      restore: async (backup, options = {}) => {
        const file = join(directory, `restore-${files++}.json`);
        writeFileSync(file, JSON.stringify(backup));
        return JSON.parse(await cli([
          "restore-tenant", "p1", "--file", file, "--json",
          ...(options.into === undefined ? [] : ["--into", options.into]),
          ...(options.tenantId === undefined ? [] : ["--tenant", options.tenantId]),
        ]));
      },
    };
  },
};

/** A Tenant with history: an update, and a post removed again, leaving a gap. */
const seed = async (api) => {
  const acme = api.forTenant("acme");
  await acme.documents.createCollection({ name: "posts" });
  for (const id of ["p1", "p2", "p3", "p4"]) await acme.documents.insert({ collection: "posts", id, data: { title: id } });
  await acme.documents.update({ collection: "posts", id: "p1", data: { title: "p1 revised" } });
  await acme.documents.delete({ collection: "posts", id: "p4" });
};

const posts = async (api) =>
  (await api.forTenant("acme").documents.findMany({ collection: "posts" })).map((d) => `${d.id}:${d.data.title}:v${d.version}`).sort();

/** The scenario, as one surface sees it: every result, refusal and resulting state. */
const scenario = async (surface, target, backup) => {
  const outcomes = [];
  const step = async (name, run) => {
    try {
      outcomes.push({ name, result: await run() });
    } catch (error) {
      outcomes.push({ name, ...refusalOf(error) });
    }
    outcomes.push({ name: `${name}: posts`, posts: await posts(target) });
  };
  await step("into an empty tenant", () => surface.restore(backup));
  // Changed since the backup was taken.
  await target.forTenant("acme").documents.insert({ collection: "posts", id: "p9", data: { title: "since" } });
  await target.forTenant("acme").documents.delete({ collection: "posts", id: "p2" });
  await step("over data, by default", () => surface.restore(backup));
  await step("in a mode there is no such thing as", () => surface.restore(backup, { into: "bogus" }));
  await step("into another tenant", () => surface.restore(backup, { tenantId: "other" }));
  await step("merged", () => surface.restore(backup, { into: "merge" }));
  await step("purged", () => surface.restore(backup, { into: "purge" }));
  await step("into an empty tenant, named", () => surface.restore(backup, { into: "empty", tenantId: "acme" }));
  return outcomes;
};

/** What each refusal is, by tag for the JS API and by the sentence the other three carry. */
const REFUSALS = {
  "over data, by default": ["TenantNotEmpty", 'Tenant "acme" already holds data; restoring would orphan it.'],
  "in a mode there is no such thing as": ["InvalidRestoreMode", 'Restore mode "bogus" is not one of empty, purge, merge.'],
  "into another tenant": ["BackupTenantMismatch", 'This backup belongs to Tenant "acme", not "other".'],
  "into an empty tenant, named": ["TenantNotEmpty", 'Tenant "acme" already holds data; restoring would orphan it.'],
};

test("backups: export, every restore mode and every refusal come out the same through JS, HTTP, the SDK and the CLI", async (t) => {
  const source = (await openTemporaryDatabase(t)).api;
  await seed(source);
  const sourcePosts = await posts(source);

  const runs = {};
  const exports = {};
  for (const [name, bind] of Object.entries(surfaces)) {
    const exporter = bind(source, t);
    const backup = await exporter.export("acme");
    // Each export is taken on its own, so only the time stamped on it differs.
    assert.ok(backup.events.every((event) => Number.isSafeInteger(event.at)), `${name}: every event is timed`);
    exports[name] = { format: backup.format, tenantId: backup.tenantId, events: backup.events.map(({ at, ...event }) => event) };
    const target = (await openTemporaryDatabase(t)).api;
    runs[name] = await scenario(bind(target, t), target, backup);
  }

  for (const name of ["http", "sdk", "cli"]) assert.deepEqual(exports[name], exports.js, `${name} exports what the JS API exports`);
  assert.equal(exports.js.format, "zelavis.db-backup.v1");

  // The JS API's own outcomes, checked against what each step means.
  const byStep = Object.fromEntries(runs.js.map((outcome) => [outcome.name, outcome]));
  const events = exports.js.events.length;
  assert.deepEqual(byStep["into an empty tenant"].result, { tenantId: "acme", events, removed: 0, superseded: 0 });
  assert.deepEqual(byStep["into an empty tenant: posts"].posts, sourcePosts);
  const changed = ["p1:p1 revised:v2", "p3:p3:v1", "p9:since:v1"];
  for (const refused of ["over data, by default", "in a mode there is no such thing as", "into another tenant"]) {
    assert.deepEqual(byStep[`${refused}: posts`].posts, changed, `${refused}: refused before anything was written`);
  }
  assert.equal(byStep.merged.result.removed, 0);
  assert.ok(byStep.merged.result.superseded > 0, "a merge writes over the records the backup carries");
  assert.deepEqual(byStep["merged: posts"].posts.map((entry) => entry.split(":")[0]), ["p1", "p2", "p3", "p9"], "a merge keeps what only the tenant holds");
  assert.ok(byStep.purged.result.removed > 0, "a purge discards what the tenant holds first");
  assert.equal(byStep.purged.result.superseded, 0);
  assert.deepEqual(byStep["purged: posts"].posts.map((entry) => entry.split(":").slice(0, 2).join(":")), ["p1:p1 revised", "p2:p2", "p3:p3"], "a purge leaves exactly the backup");

  for (const [name, outcomes] of Object.entries(runs)) {
    assert.deepEqual(outcomes.map((outcome) => outcome.name), runs.js.map((outcome) => outcome.name));
    for (const [index, outcome] of outcomes.entries()) {
      const expected = runs.js[index];
      const refusal = REFUSALS[outcome.name];
      if (refusal !== undefined) {
        assert.deepEqual(outcome, { name: outcome.name, refused: name === "js" ? refusal[0] : refusal[1] }, `${name}: ${outcome.name}`);
      } else {
        assert.deepEqual(outcome, expected, `${name}: ${outcome.name}`);
      }
    }
  }
});

test("backups: the SDK sends only what it is given, to the Project proxy", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  await seed(api);
  const requests = [];
  const client = createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: platform(api, requests) });

  // With no Tenant named and none of its own, there is nothing to export.
  await assert.rejects(client.projects.exportTenant("p1"), /Tenant ID is required/);
  assert.deepEqual(requests.at(-1), { action: "export", body: {} });
  // A caller the Gateway signed a Tenant for exports that one when it names none.
  const own = createZelavisClient({
    baseUrl: "http://zv.test", rootPath: "/zelavis",
    fetch: platform(api, requests, { ...operator, metadata: { tenantId: "acme" } }),
  });
  assert.equal((await own.projects.exportTenant("p1")).tenantId, "acme");

  const named = await client.projects.exportTenant("p1", { tenantId: "acme" });
  assert.deepEqual(requests.at(-1), { action: "export", body: { tenantId: "acme" } });
  await client.projects.restoreTenant("p1", named, { into: "purge" });
  assert.deepEqual(requests.at(-1), { action: "restore", body: { backup: named, into: "purge" } });
});

test("backups: the CLI prints a backup, writes one owner-only, and checks its flags and files", async (t) => {
  const { api } = await openTemporaryDatabase(t);
  await seed(api);
  const directory = mkdtempSync(join(tmpdir(), "zv-backup-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });
  globalThis.fetch = platform(api);
  const lines = [];
  console.log = (line) => lines.push(String(line));
  const cli = (...args) => runProjectsCommand([...args, "--url", BASE]);

  // Without --output the backup is what is printed.
  await cli("export-tenant", "p1", "--tenant", "acme");
  const printed = JSON.parse(lines.at(-1));
  assert.equal(printed.tenantId, "acme");
  assert.equal(printed.format, "zelavis.db-backup.v1");

  const file = join(directory, "acme.json");
  await cli("export-tenant", "p1", "--tenant", "acme", "--output", file);
  assert.equal(lines.at(-1), `Exported ${printed.events.length} events of Tenant acme to ${file}.`);
  const untimed = (events) => events.map(({ at, ...event }) => event);
  assert.deepEqual(untimed(JSON.parse(readFileSync(file, "utf8")).events), untimed(printed.events));
  assert.equal(statSync(file).mode & 0o777, 0o600, "a backup is written owner-only");
  await cli("export-tenant", "p1", "--tenant", "acme", "--output", file, "--json");
  assert.deepEqual(JSON.parse(lines.at(-1)), { tenantId: "acme", events: printed.events.length, file });

  await api.forTenant("acme").documents.insert({ collection: "posts", id: "p9", data: { title: "since" } });
  await cli("restore-tenant", "p1", "--file", file, "--into", "purge");
  assert.match(lines.at(-1), new RegExp(`^Restored ${printed.events.length} events into Tenant acme, removing \\d+ records first\\.$`));

  await assert.rejects(cli("restore-tenant", "p1"), /requires --file/);
  await assert.rejects(cli("export-tenant", "p1", "--into", "purge"), /--file and --into are only supported by projects restore-tenant/);
  await assert.rejects(cli("restore-tenant", "p1", "--file", file, "--output", file), /--output is only supported by projects export-tenant/);
  await assert.rejects(cli("start", "p1", "--tenant", "acme"), /--tenant is only supported/);
  const notBackup = join(directory, "not-a-backup.json");
  writeFileSync(notBackup, JSON.stringify({ hello: "world" }));
  await assert.rejects(cli("restore-tenant", "p1", "--file", notBackup), /not-a-backup\.json is not a Tenant backup/);
  writeFileSync(notBackup, "{");
  await assert.rejects(cli("restore-tenant", "p1", "--file", notBackup), /not-a-backup\.json is not JSON/);
});
