import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

// An upgrade that changes the data layout is never live: the Project is stopped, the driver migrates and swaps the data in
// `prepare`, settles it with `commitUpgrade`/`abandonUpgrade`, and the Project starts again. Engine 1.0.0 writes format 2,
// engine 2.0.0 format 4 and engine 2.0.1 also format 4.
const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const formats = { "1.0.0": 2, "2.0.0": 4, "2.0.1": 4 };
const digest = version => `sha256:${(version.startsWith("1") ? "a" : "b").repeat(64)}`;
const recipe = version => ({ name: "@zelavis/app", title: "Zelavis App", version, specifier: "@zelavis/app", runtimeKinds: ["native"], artifact: { digest: digest(version) } });

async function platform(t, { failPrepare = false } = {}) {
  const store = createMemorySystemStore(), selected = new Map(), running = new Set(), data = new Map(), reports = new Map(), calls = [];
  const runtime = {
    name: "qualified-fixture", runtimeKinds: ["native"],
    capabilities: () => ({ zeroDowntimeUpdates: true, independentRuntimeVersion: true }), supportsLiveUpdate: () => true,
    async versions(project) {
      const current = project ? selected.get(project.id) : undefined;
      return { selectable: true, current, ...(current ? { currentDataFormat: data.get(project.id) ?? formats[current] } : {}), latest: "2.0.1",
        versions: Object.keys(formats).map(version => ({ version, status: "available", dataFormat: formats[version] })) };
    },
    async resolveVersion(project, version = "2.0.1") {
      if (!formats[version]) throw Error("Unavailable installed engine");
      return { engineVersion: version, recipe: recipe(version) };
    },
    async prepare(project) {
      calls.push(["prepare", project.engineVersion]);
      const before = selected.get(project.id);
      if (before !== undefined && formats[before] !== formats[project.engineVersion]) {
        if (failPrepare) throw Error("migration failed");
        data.set(project.id, formats[project.engineVersion]);
        reports.set(project.id, { from: formats[before], to: formats[project.engineVersion], tenants: 1, collections: 1, documents: 3, documentsWithHistoryDropped: 1, retained: "data.format-2-x" });
      }
      selected.set(project.id, project.engineVersion);
    },
    async commitUpgrade(id) { calls.push(["commit", id]); return reports.get(id); },
    async abandonUpgrade(id) { calls.push(["abandon", id]); },
    async start(project) { calls.push(["start", project.id]); running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { calls.push(["stop", id]); running.delete(id); return { status: "stopped" }; },
    async status(id) { return { status: running.has(id) ? "running" : "stopped", ...(running.has(id) ? { url: "http://127.0.0.1:1" } : {}) }; },
    async prepareUpdate(previous, candidate) {
      calls.push(["prepareUpdate", candidate.engineVersion]);
      return { mode: "engine", previous: { version: selected.get(previous.id), digest: digest(selected.get(previous.id)) }, target: { version: candidate.engineVersion, digest: digest(candidate.engineVersion) }, recipe: candidate.recipe };
    },
    async applyUpdate(id, update, commit) { calls.push(["applyUpdate", update.target.version]); selected.set(id, update.target.version); await commit("target"); return this.status(id); },
    async recoverUpdate(id, update) { return selected.get(id) === update.target.version ? "target" : "previous"; },
    async logs() { return []; }, async destroy(id) { selected.delete(id); running.delete(id); }, async close() {},
  };
  const catalog = Object.keys(formats).map(version => ({ service: { ...recipe(version), kind: "app", project: { runtimeKinds: ["native"] } }, specifier: "@zelavis/app", source: "official", status: "available" }));
  const zv = await zelavis({ systemStore: store, projectRuntime: runtime, serviceRegistry: { catalog: [catalog[2]] } });
  t.after(() => zv.close());
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => zv.fetch(new Request(url, init), { principal: owner }) });
  return { client, selected, data, calls, running };
}

test("an upgrade across a data-layout change stops the Project, migrates in prepare, commits and starts it again, never live", async t => {
  const { client, selected, data, calls, running } = await platform(t);
  const project = await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  assert.equal(project.runtime.status, "running");
  calls.length = 0;
  const upgraded = await client.projects.upgrade("old", { restart: true });
  assert.equal(upgraded.engineVersion, "2.0.1");
  assert.equal(upgraded.runtime.status, "running");
  assert.equal(selected.get("old"), "2.0.1");
  assert.equal(data.get("old"), 4, "the driver migrated the data");
  assert.deepEqual(upgraded.dataMigration, { from: 2, to: 4, tenants: 1, collections: 1, documents: 3, documentsWithHistoryDropped: 1, retained: "data.format-2-x" }, "the upgrade response carries the report");
  const order = calls.map(call => call[0]);
  assert.ok(order.indexOf("stop") < order.indexOf("prepare") && order.indexOf("prepare") < order.indexOf("commit") && order.indexOf("commit") < order.lastIndexOf("start"), `stopped, migrated while stopped, settled, started again: ${order}`);
  assert.ok(!order.includes("prepareUpdate") && !order.includes("applyUpdate"), "never the live engine handover");
  assert.ok(running.has("old"));
});

test("an upgrade within one layout is still live", async t => {
  const { client, calls } = await platform(t);
  await client.projects.create({ id: "same", name: "Same", engineVersion: "2.0.0" });
  calls.length = 0;
  await client.projects.upgrade("same", { restart: true });
  assert.deepEqual(calls.map(call => call[0]), ["prepareUpdate", "applyUpdate"], "no stop, no data migration");
});

test("a failed migration leaves the Project on its old engine and running again", async t => {
  const { client, selected, calls } = await platform(t, { failPrepare: true });
  await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  calls.length = 0;
  await assert.rejects(client.projects.upgrade("old", { restart: true }));
  const after = await client.projects.get("old");
  assert.equal(after.engineVersion, "1.0.0");
  assert.equal(after.runtime.status, "running", "it is started again as the Project it was");
  assert.equal(selected.get("old"), "1.0.0");
  assert.ok(!calls.some(call => call[0] === "commit"), "nothing is committed");
});
