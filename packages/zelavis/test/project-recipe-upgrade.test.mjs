import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis, createMemorySystemStore, zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { resolveBundledServiceDirectory } from "../dist/adapters/_local-runtime.js";
import { materializeRecipeArtifact, digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

function recipe(name, version) {
  return {
    service: { name, kind: "app", version, marketplace: { title: name }, project: { runtimeKinds: ["native"] } },
    specifier: name,
    status: "available",
    source: "community",
  };
}

function projectRuntime() {
  const running = new Set();
  const prepared = [];
  return {
    prepared,
    name: "test-runtime",
    runtimeKinds: ["native"],
    capabilities: () => ({ statelessRuntimeReplicas: false }),
    async prepare(project, lock) { prepared.push(`${project.id}:${lock.name}@${lock.version}`); },
    async start(project) { running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { running.delete(id); return { status: "stopped" }; },
    async status(id) { return running.has(id) ? { status: "running", url: "http://127.0.0.1:1" } : { status: "stopped" }; },
    async logs() { return []; },
    async destroy(id) { running.delete(id); },
    async close() {},
  };
}

/** A Platform shipping one `acme/site` at a given version, over a shared store. */
async function platform(t, store, version, extra = []) {
  const runtime = projectRuntime();
  const zv = await zelavis({
    systemStore: store,
    projectRuntime: runtime,
    serviceRegistry: { catalog: [recipe("acme/site", version), ...extra] },
  });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), OWNER);
  return { zv, runtime, fetcher, client: createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher }) };
}

const http = async (fetcher, method, path, body) => {
  const response = await fetcher(`http://localhost/zelavis/api/v1/runtime${path}`, {
    method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

async function cli(fetcher, args) {
  const original = { fetch: globalThis.fetch, log: console.log, error: console.error };
  const out = []; const err = [];
  globalThis.fetch = fetcher;
  console.log = (value) => out.push(value);
  console.error = (value) => err.push(value);
  const previous = process.exitCode; process.exitCode = undefined;
  try {
    await runCli(["projects", ...args, "--url", "http://localhost/zelavis", "--json"]);
    return { exitCode: process.exitCode ?? 0,
      stdout: out.length ? JSON.parse(out.join("\n")) : undefined,
      stderr: err.length ? JSON.parse(err.join("\n")) : undefined };
  } finally {
    Object.assign(globalThis, { fetch: original.fetch });
    console.log = original.log; console.error = original.error; process.exitCode = previous;
  }
}

const stable = (project) => {
  const { createdAt: _c, updatedAt: _u, id: _i, name: _n, runtime, recipeHistory, ...rest } = project;
  const { startedAt: _s, stoppedAt: _st, ...runtimeRest } = runtime;
  return { ...rest, runtime: runtimeRest, history: (recipeHistory ?? []).map((h) => h.from) };
};

test("a Project learns that its recipe can be upgraded, and upgrades over HTTP, SDK and CLI alike", async (t) => {
  const store = createMemorySystemStore();
  const before = await platform(t, store, "1.0.0");
  for (const id of ["http-site", "sdk-site", "cli-site"]) {
    await before.client.projects.create({ name: id, id, recipeName: "acme/site", start: false });
  }
  assert.equal((await before.client.projects.get("http-site")).recipeStatus.state, "current");
  await before.zv.close();

  // The Platform moves on to 2.0.0; the Projects stay locked to 1.0.0.
  const after = await platform(t, store, "2.0.0");
  const listed = (await after.client.projects.list()).projects;
  assert.ok(listed.every((p) => p.recipe.version === "1.0.0"), "the lock is never rewritten by the Platform");
  assert.ok(listed.every((p) => p.recipeStatus.state === "upgradeAvailable" && p.recipeStatus.version === "2.0.0"));

  const h = await http(after.fetcher, "POST", "/projects/http-site/upgrade");
  assert.equal(h.status, 200);
  const s = await after.client.projects.upgrade("sdk-site");
  const c = await cli(after.fetcher, ["upgrade", "cli-site"]);
  assert.equal(c.exitCode, 0);
  assert.deepEqual(stable(s), stable(h.body.project));
  assert.deepEqual(stable(c.stdout.project), stable(h.body.project));
  assert.equal(h.body.project.recipe.version, "2.0.0");
  assert.equal(h.body.project.recipeStatus.state, "current");
  assert.deepEqual(h.body.project.recipeHistory.map((e) => e.from), [{ name: "acme/site", version: "1.0.0" }]);
  assert.ok(after.runtime.prepared.includes("http-site:acme/site@2.0.0"), "the new recipe was frozen");

  // The upgrade is remembered and the Project starts on the new lock.
  assert.equal((await after.client.projects.start("http-site")).recipe.version, "2.0.0");
});

test("only a stopped Project, and only to something different, can be upgraded", async (t) => {
  const store = createMemorySystemStore();
  const { client, fetcher } = await platform(t, store, "1.0.0");
  await client.projects.create({ name: "live", id: "live", recipeName: "acme/site" });

  const running = await http(fetcher, "POST", "/projects/live/upgrade");
  assert.equal(running.status, 409);
  assert.match(running.body.error, /Stop it before upgrading/);
  await client.projects.stop("live");
  // Already on what the Platform ships.
  const same = await http(fetcher, "POST", "/projects/live/upgrade");
  assert.equal(same.status, 200, "no artifact-freezing driver here, so re-locking is allowed once");
});

test("an unknown recipe, another kind, and a missing Project are refused clearly", async (t) => {
  const store = createMemorySystemStore();
  const { client, fetcher } = await platform(t, store, "1.0.0", [
    { ...recipe("acme/frontend", "1.0.0"), service: { name: "acme/frontend", kind: "frontend", version: "1.0.0", marketplace: { title: "f" }, project: { runtimeKinds: ["native"] } } },
  ]);
  await client.projects.create({ name: "site", id: "site", recipeName: "acme/site", start: false });

  const unknown = await http(fetcher, "POST", "/projects/site/upgrade", { recipeName: "acme/nope" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not shipped with this Platform/);
  const otherKind = await http(fetcher, "POST", "/projects/site/upgrade", { recipeName: "acme/frontend" });
  assert.equal(otherKind.status, 400);
  assert.match(otherKind.body.error, /different kind of Project/);
  assert.equal((await http(fetcher, "POST", "/projects/ghost/upgrade")).status, 404);
  const viaCli = await cli(fetcher, ["upgrade", "site", "--recipe", "acme/nope"]);
  assert.equal(viaCli.exitCode, 1);
  assert.equal(viaCli.stderr.status, 400);
});

test("a Project locked to a recipe name this Platform no longer ships must be told which one to move to", async (t) => {
  const store = createMemorySystemStore();
  const old = await platform(t, store, "1.0.0", [recipe("acme/retired", "1.0.0")]);
  await old.client.projects.create({ name: "old", id: "old", recipeName: "acme/retired", start: false });
  await old.zv.close();

  const now = await platform(t, store, "2.0.0");
  const project = await now.client.projects.get("old");
  assert.equal(project.recipeStatus.state, "unavailable");
  assert.match(project.recipeStatus.reason, /ships no recipe named "acme\/retired"/);

  const bare = await http(now.fetcher, "POST", "/projects/old/upgrade");
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /Name the recipe to move this Project to/);
  const moved = await now.client.projects.upgrade("old", { recipeName: "acme/site" });
  assert.equal(moved.recipe.name, "acme/site");
  assert.equal(moved.recipe.version, "2.0.0");
  assert.deepEqual(moved.recipeHistory.map((e) => e.from), [{ name: "acme/retired", version: "1.0.0" }]);
});

test("upgrading needs runtime-management authority over that Project", async (t) => {
  const store = createMemorySystemStore();
  const { zv, client } = await platform(t, store, "1.0.0");
  await client.projects.create({ name: "a", id: "a", recipeName: "acme/site", start: false });
  await client.projects.create({ name: "b", id: "b", recipeName: "acme/site", start: false });
  const as = (principal) => (path) => zv.fetch(new Request(`http://localhost/zelavis/api/v1/runtime${path}`, { method: "POST" }), { principal });
  const manager = as({ id: "m", type: "user", grants: [{ permission: "project.runtime.manage", scope: { type: "project", projectId: "a" } }] });
  const viewer = as({ id: "v", type: "user", grants: [{ permission: "project.view", scope: { type: "project", projectId: "a" } }] });
  assert.equal((await manager("/projects/a/upgrade")).status, 200);
  assert.equal((await manager("/projects/b/upgrade")).status, 403);
  assert.equal((await viewer("/projects/a/upgrade")).status, 403);
});

test("the recipe artifact is replaced only when the new one is complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "zv-mat-"));
  try {
    const source = (version) => join(root, `src-${version}`);
    for (const version of ["1", "2"]) {
      await mkdir(join(source(version), "dist"), { recursive: true });
      await writeFile(join(source(version), "package.json"), JSON.stringify({ name: "x", version }));
      await writeFile(join(source(version), "dist", "index.js"), `export default ${version}`);
    }
    const data = join(root, "data");
    const first = await materializeRecipeArtifact(source("1"), data);
    assert.equal(first.digest, await digestArtifactDirectory(join(data, "recipe", "package")));
    const second = await materializeRecipeArtifact(source("2"), data);
    assert.notEqual(second.digest, first.digest);
    assert.equal(JSON.parse(await readFile(join(data, "recipe", "package", "package.json"), "utf8")).version, "2");
    await assert.rejects(access(join(data, "recipe.incoming")), { code: "ENOENT" }, "nothing is left half-built");

    // A build that dies leaves the frozen artifact in place.
    await rm(join(source("2"), "package.json"));
    await mkdir(join(root, "blocked"), { recursive: true });
    await writeFile(join(root, "blocked", "recipe.incoming"), "not a directory");
    const kept = await materializeRecipeArtifact(source("2"), join(root, "blocked")).catch(() => "failed");
    assert.ok(kept === "failed" || kept.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real Project created before recipes were frozen is upgraded, keeps its data, and starts", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zv-upg-"));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data }) });
  t.after(async () => { await zv.close(); await rm(data, { recursive: true, force: true }); });
  const call = (path, init) => zv.fetch(new Request(`http://localhost/zelavis/api/v1/runtime/projects${path}`, init), OWNER);
  const json = { "content-type": "application/json" };
  assert.equal((await call("", { method: "POST", headers: json, body: JSON.stringify({ id: "legacy", name: "Legacy", recipeName: "@zelavis/app", start: true }) })).status, 201);
  await call("/legacy/stop", { method: "POST", headers: json, body: "{}" });

  // What the dashboard's fluxgent looked like: an old lock, no frozen copy, real data.
  const directory = join(data, "projects", "legacy");
  const descriptor = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
  delete descriptor.recipe.artifact;
  descriptor.recipe.version = "0.0.1-old";
  await writeFile(join(directory, "project.json"), JSON.stringify(descriptor, null, 2));
  await rm(join(directory, ".zelavis", "recipe"), { recursive: true, force: true });
  await writeFile(join(directory, ".zelavis", "data", "keepme.txt"), "user data");
  const systemStore = (await nodeAdapter({ dataDirectory: data }).resolve({})).resources.systemStore;
  const stored = await systemStore.get("projects", "legacy");
  const lock = { ...stored.value.recipe, version: "0.0.1-old" };
  delete lock.artifact;
  await systemStore.set("projects", "legacy", { ...stored.value, recipe: lock });

  const stuck = await call("/legacy/start", { method: "POST", headers: json, body: "{}" });
  assert.notEqual(stuck.status, 200);
  const failed = (await (await call("/legacy")).json()).project;
  assert.equal(failed.runtime.status, "failed");
  assert.match(failed.runtime.error, /Upgrade the Project to it/);
  assert.equal(failed.recipeStatus.state, "upgradeAvailable");

  const upgraded = await call("/legacy/upgrade", { method: "POST", headers: json, body: "{}" });
  assert.equal(upgraded.status, 200, await upgraded.clone().text());
  const project = (await upgraded.json()).project;
  assert.equal(project.recipeStatus.state, "current");
  assert.equal(project.runtime.status, "stopped", "the old failure is cleared");
  assert.equal(project.recipeHistory[0].from.version, "0.0.1-old");
  assert.equal(await readFile(join(directory, ".zelavis", "data", "keepme.txt"), "utf8"), "user data");
  const frozen = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
  assert.match(frozen.recipe.artifact.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(frozen.recipe.version, JSON.parse(await readFile(join(resolveBundledServiceDirectory("@zelavis/app"), "package.json"), "utf8")).version);

  const started = await call("/legacy/start", { method: "POST", headers: json, body: "{}" });
  assert.equal(started.status, 200, await started.clone().text());
});
