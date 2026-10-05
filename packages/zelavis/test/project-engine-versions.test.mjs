import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";

const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const digest = version => `sha256:${(version.startsWith("1") ? "a" : "b").repeat(64)}`;
const recipe = version => ({ name: "@zelavis/app", title: "Zelavis App", version, specifier: "@zelavis/app", runtimeKinds: ["native"], artifact: { digest: digest(version) } });
async function platform(t, failCommit = false) {
  const store = createMemorySystemStore(), selected = new Map(), running = new Set();
  let inject = false;
  const guarded = { ...store, async set(namespace, id, value) {
    if (inject && value.engineVersion === "2.0.0") { inject = false; throw Error("Rejected engine lock commit"); }
    return store.set(namespace, id, value);
  } };
  const runtime = {
    name: "qualified-fixture", runtimeKinds: ["native"],
    capabilities: () => ({ zeroDowntimeUpdates: true, independentRuntimeVersion: true }), supportsLiveUpdate: () => true,
    async versions(project) { return { selectable: true, current: project ? selected.get(project.id) : undefined, latest: "2.0.0", versions: ["2.0.0", "1.0.0"].map(version => ({ version, status: "available" })) }; },
    async resolveVersion(project, version = "2.0.0") {
      if (!["1.0.0", "2.0.0"].includes(version)) throw Error("Unavailable installed engine");
      return { engineVersion: version, recipe: recipe(version) };
    },
    async prepare(project) {
      if (failCommit && selected.has(project.id) && selected.get(project.id) !== project.engineVersion && project.engineVersion === "2.0.0") inject = true;
      selected.set(project.id, project.engineVersion);
    },
    async start(project) { running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { running.delete(id); return { status: "stopped" }; },
    async status(id) { return { status: running.has(id) ? "running" : "stopped", ...(running.has(id) ? { url: "http://127.0.0.1:1" } : {}) }; },
    async prepareUpdate(previous, candidate) {
      return { mode: "engine", previous: { version: selected.get(previous.id), digest: digest(selected.get(previous.id)) },
        target: { version: candidate.engineVersion, digest: digest(candidate.engineVersion) }, recipe: candidate.recipe };
    },
    async applyUpdate(id, update, commit) {
      selected.set(id, update.target.version);
      try { if (failCommit) inject = true; await commit("target"); }
      catch (error) { selected.set(id, update.previous.version); await commit("previous"); throw error; }
      return this.status(id);
    },
    async recoverUpdate(id, update) { return selected.get(id) === update.target.version ? "target" : "previous"; },
    async logs() { return []; }, async destroy(id) { selected.delete(id); running.delete(id); }, async close() {},
  };
  const zv = await zelavis({ systemStore: guarded, projectRuntime: runtime, serviceRegistry: { catalog: [{ service: { ...recipe("2.0.0"), kind: "app", project: { runtimeKinds: ["native"] } }, specifier: "@zelavis/app", source: "official", status: "available" }] } });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), { principal: owner });
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  return { zv, client, fetcher, selected, store };
}

test("create defaults to latest, explicit older versions select matching recipes, and live switches preserve runtime URL", async t => {
  const { client, selected, store } = await platform(t);
  assert.equal((await client.projects.create({ id: "latest", name: "Latest" })).engineVersion, "2.0.0");
  const old = await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  assert.equal(old.recipe.version, "1.0.0");
  const versions = await client.projects.versions(old.id);
  assert.equal(versions.current, "1.0.0");
  assert.equal((await client.projects.versions()).latest, "2.0.0");
  for (const version of ["2.0.0", "1.0.0"]) {
    const changed = await client.projects.switchVersion(old.id, version);
    assert.equal(changed.engineVersion, version); assert.equal(changed.recipe.version, version);
    assert.equal(changed.runtime.status, "running"); assert.equal(changed.runtime.url, old.runtime.url);
    assert.equal(changed.runtimeUpdate, undefined); assert.equal(selected.get(old.id), version);
    assert.equal((await store.get("projects", old.id)).value.engineVersion, version);
  }
});

test("a failed handover lock commit restores engine, recipe and durable selection", async t => {
  const { client, selected, store } = await platform(t, true);
  const old = await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  await assert.rejects(client.projects.switchVersion(old.id, "2.0.0"), { status: 500 });
  const restored = await client.projects.get(old.id);
  assert.equal(restored.engineVersion, "1.0.0"); assert.equal(restored.recipe.version, "1.0.0");
  assert.equal(restored.runtime.url, old.runtime.url); assert.equal(restored.runtimeUpdate, undefined);
  assert.equal(selected.get(old.id), "1.0.0"); assert.equal((await store.get("projects", old.id)).value.engineVersion, "1.0.0");
});

test("version controls enforce exact versions, Project permission and deletion precedence", async t => {
  const { client, zv, store } = await platform(t);
  await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  for (const version of ["latest", "^2.0.0", "../2.0.0", ""]) await assert.rejects(client.projects.switchVersion("old", version), { status: 400 });
  await assert.rejects(client.projects.create({ id: "bad", name: "Bad", engineVersion: 17 }), { status: 400 });
  assert.equal(await store.get("projects", "bad"), undefined);
  const viewer = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => zv.fetch(new Request(url, init), { principal: { id: "viewer", type: "user", permissions: ["project.view"] } }) });
  await assert.rejects(viewer.projects.switchVersion("old", "2.0.0"), { status: 403 });
  await assert.rejects(client.projects.versions("missing"), { status: 404 });
  const record = await store.get("projects", "old");
  await store.set("projects", "old", { ...record.value, deletion: { status: "failed", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), participants: ["runtime"], completedParticipants: [], error: "cleanup failed" } });
  await assert.rejects(client.projects.switchVersion("old", "2.0.0"), { status: 409 });
  assert.equal((await store.get("projects", "old")).value.engineVersion, "1.0.0");
});

test("CLI version operations use the SDK routes and return matching locks", async t => {
  const { client, fetcher } = await platform(t);
  await client.projects.create({ id: "old", name: "Old", engineVersion: "1.0.0" });
  const previous = { fetch: globalThis.fetch, log: console.log };
  const output = [];
  try {
    globalThis.fetch = fetcher; console.log = text => output.push(JSON.parse(text));
    await runCli(["projects", "versions", "old", "--json"]);
    await runCli(["projects", "switch-version", "old", "--engine-version", "2.0.0", "--json"]);
    assert.equal(output[0].current, "1.0.0"); assert.equal(output[1].project.engineVersion, "2.0.0");
  } finally { globalThis.fetch = previous.fetch; console.log = previous.log; }
});


test("a stopped version switch restores prepared engine selection if the registry commit fails", async t => {
  const { client, selected } = await platform(t, true);
  await client.projects.create({ id: "stopped", name: "Stopped", engineVersion: "1.0.0", start: false });
  await assert.rejects(client.projects.switchVersion("stopped", "2.0.0"), { status: 500 });
  assert.equal(selected.get("stopped"), "1.0.0");
  assert.equal((await client.projects.get("stopped")).engineVersion, "1.0.0");
  const started = await client.projects.start("stopped");
  assert.equal(started.recipe.version, "1.0.0");
  assert.equal(started.runtime.status, "running");
});


test("remote placement cannot be changed through a local engine selector", async t => {
  const { client, store, selected } = await platform(t);
  await client.projects.create({ id: "remote", name: "Remote", engineVersion: "1.0.0", start: false });
  const previous = await store.get("projects", "remote");
  await store.set("projects", "remote", { ...previous.value, placement: { nodeId: "another-node" } });
  assert.equal((await client.projects.versions("remote")).selectable, false);
  await assert.rejects(client.projects.switchVersion("remote", "2.0.0"), { status: 409 });
  assert.equal(selected.get("remote"), "1.0.0");
  assert.equal((await store.get("projects", "remote")).value.engineVersion, "1.0.0");
});
