// Install method and software version: chosen once at creation from what the host can do,
// locked in the Project, checked (never re-chosen) at start, kept across a recipe upgrade.
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { manifestProjectRecipe } from "../dist/service.js";
import { compareSoftwareVersions, parseRecipeManifest, selectRecipeSoftware } from "zelavis/recipe";

const manifest = (over = {}) => ({
  contract: 1,
  methods: [
    { id: "native", driver: "js", entry: "./recipe.mjs", requires: ["nginx", "php-fpm"] },
    { id: "container", driver: "oci", image: `registry.example/app@sha256:${"a".repeat(64)}`, requires: ["docker"] },
  ],
  software: [
    { version: "7.1.2", archive: "https://example.com/7.1.2.tar.gz", sha256: "b".repeat(64), maxBytes: 1000 },
    { version: "7.10.0", archive: "https://example.com/7.10.0.tar.gz", sha256: "c".repeat(64), maxBytes: 1000 },
    { version: "6.9", archive: "https://example.com/6.9.tar.gz", sha256: "d".repeat(64), maxBytes: 1000 },
  ],
  ports: [{ name: "web", protocol: "http" }],
  ...over,
});

const recipe = (version, install = manifest(), name = "@acme/site") => ({
  service: { name, kind: "app", version, api: {}, service: {}, project: { runtimeKinds: ["native"], ...(install ? { install: parseRecipeManifest(install) } : {}) } },
  specifier: name, status: "available", source: "official", order: 0,
});

function driver() {
  const starts = [];
  const calls = [];
  return {
    starts, calls,
    runtime: {
      name: "test-runtime",
      capabilities: () => ({
        independentRuntimeVersion: false, movable: false, liveMigration: false, secureIsolation: false, resourceLimits: false,
        persistentFilesystem: true, statelessRuntimeReplicas: false, managedStorage: false, managedDatabase: false,
        databaseReplication: false, tenantPlacement: false, databaseSharding: false,
        runtimeOwnership: "platform-process", survivesControlPlaneRestart: false, description: "test",
      }),
      async prepare(project) { calls.push(["prepare", project.id, project.recipe.version]); },
      async commitUpgrade(id) { calls.push(["commit", id]); },
      async abandonUpgrade(id) { calls.push(["abandon", id]); },
      async start(project) { starts.push(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
      async stop() { return { status: "stopped" }; },
      async status() { return { status: "stopped" }; },
      async logs() { return []; },
      async destroy() {},
      async close() {},
    },
  };
}

async function setup(host = { drivers: ["js", "oci"], requirements: ["nginx", "php-fpm", "docker"] }, recipes = [recipe("1.0.0")]) {
  const store = createMemorySystemStore();
  const running = driver();
  const state = { host };
  const open = (list = recipes) => createProjectManager({
    store, projectRecipes: list, runtime: running.runtime, autoReconcile: false,
    ...(state.host ? { installHost: async () => state.host } : {}),
  });
  return { store, running, state, open, manager: await open() };
}

test("software versions compare numerically and the newest is the default", () => {
  assert.ok(compareSoftwareVersions("7.10.0", "7.9.9") > 0, "7.10 is newer than 7.9");
  assert.ok(compareSoftwareVersions("6.9", "6.9.0") === 0);
  const parsed = parseRecipeManifest(manifest());
  assert.equal(selectRecipeSoftware(parsed).version, "7.10.0");
  assert.equal(selectRecipeSoftware(parsed, "6.9").version, "6.9");
  assert.throws(() => selectRecipeSoftware(parsed, "8.0"), (error) => error._tag === "RecipeSoftwareUnavailable" && /7\.1\.2, 7\.10\.0, 6\.9/.test(error.message));
});

test("a package's install manifest is validated when it is loaded", () => {
  const pkg = (install) => ({ name: "@acme/site", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"], install } } });
  const loaded = manifestProjectRecipe(pkg(manifest()));
  assert.equal(loaded.install.software.length, 3);
  assert.ok(Object.isFrozen(loaded.install));
  assert.throws(() => manifestProjectRecipe(pkg({ ...manifest(), contract: 2 })), /@acme\/site.*zelavis\.project\.install/);
  assert.throws(() => manifestProjectRecipe(pkg({ ...manifest(), extra: true })), /zelavis\.project\.install/);
  assert.equal(manifestProjectRecipe({ name: "x", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"] } } }).install, undefined);
});

test("creation locks the first method the host can run and the newest software, once", async () => {
  const { manager } = await setup();
  const project = await manager.create({ name: "Site", recipeName: "@acme/site", start: false });
  assert.deepEqual(project.recipe.install, { method: "native", driver: "js", requires: ["nginx", "php-fpm"], software: "7.10.0" });
  const stored = await manager.get("site");
  assert.deepEqual(stored.recipe.install, project.recipe.install, "it is part of the stored record");
  await manager.close();
});

test("an explicit method and software version are honored, and a refused one names why and substitutes nothing", async () => {
  const { manager } = await setup();
  const chosen = await manager.create({ name: "Box", recipeName: "@acme/site", method: "container", softwareVersion: "6.9", start: false });
  assert.deepEqual(chosen.recipe.install, { method: "container", driver: "oci", requires: ["docker"], software: "6.9" });
  await assert.rejects(manager.create({ name: "Bad", recipeName: "@acme/site", method: "nope", start: false }), /requested recipe method "nope" is unavailable; no alternative/);
  await assert.rejects(manager.create({ name: "Old", recipeName: "@acme/site", softwareVersion: "5.0", start: false }), /not offered by this recipe/);
  assert.equal(await manager.get("bad"), undefined, "nothing was created");
  await manager.close();
});

test("a host that cannot run a method does not pick another for an explicit request, and falls through for none", async () => {
  const limited = await setup({ drivers: ["js"], requirements: ["docker"] });
  await assert.rejects(limited.manager.create({ name: "A", recipeName: "@acme/site", start: false }), /cannot satisfy any declared recipe method/);
  await limited.manager.close();
  const containerOnly = await setup({ drivers: ["oci"], requirements: ["docker"] });
  const project = await containerOnly.manager.create({ name: "B", recipeName: "@acme/site", start: false });
  assert.equal(project.recipe.install.method, "container", "no explicit request: the first method this host can satisfy");
  await containerOnly.manager.close();
  const unproven = await setup(false);
  await assert.rejects(unproven.manager.create({ name: "C", recipeName: "@acme/site", start: false }), /cannot prove it supports/);
  await unproven.manager.close();
});

test("a recipe with nothing to choose refuses a choice, and needs no host proof", async () => {
  const { manager } = await setup(undefined, [recipe("1.0.0", null, "@acme/plain")]);
  await assert.rejects(manager.create({ name: "P", recipeName: "@acme/plain", method: "native", start: false }), /no install method or software version to choose/);
  const plain = await manager.create({ name: "P", recipeName: "@acme/plain", start: false });
  assert.equal(plain.recipe.install, undefined);
  await manager.close();
});

test("start and restart check the lock and refuse when the method is gone; they never choose another", async () => {
  const { manager, state, running } = await setup();
  await manager.create({ name: "Site", recipeName: "@acme/site", start: false });
  state.host = { drivers: ["js", "oci"], requirements: ["docker"] }; // nginx and php-fpm are gone
  await assert.rejects(manager.start("site"), /created with the "native" install method, which needs nginx, php-fpm; this host does not provide it\. Zelavis will not switch methods/);
  assert.deepEqual(running.starts, []);
  assert.equal((await manager.get("site")).recipe.install.method, "native", "the lock is untouched");
  state.host = { drivers: [], requirements: ["nginx", "php-fpm"] };
  await assert.rejects(manager.start("site"), /needs the js driver/);
  state.host = { drivers: ["js"], requirements: ["nginx", "php-fpm"] };
  assert.equal((await manager.start("site")).runtime.status, "running");
  state.host = { drivers: ["js"], requirements: [] };
  await assert.rejects(manager.restart("site"), /needs nginx, php-fpm/);
  await manager.close();
});

test("a recipe upgrade keeps the choice when it is still offered and refuses when it is not", async () => {
  const { manager, state, open } = await setup(undefined, [recipe("1.0.0")]);
  state.host = { drivers: ["js"], requirements: ["nginx", "php-fpm"] };
  await manager.create({ name: "Site", recipeName: "@acme/site", softwareVersion: "7.1.2", start: false });
  await manager.close();

  const newer = await open([recipe("1.1.0")]);
  const upgraded = await newer.upgrade("site");
  assert.equal(upgraded.recipe.version, "1.1.0");
  assert.deepEqual(upgraded.recipe.install, { method: "native", driver: "js", requires: ["nginx", "php-fpm"], software: "7.1.2" });
  await newer.close();

  const dropped = await open([recipe("1.2.0", manifest({ software: [manifest().software[1]] }))]);
  await assert.rejects(dropped.upgrade("site"), /no longer offers the "native" method with software 7\.1\.2/);
  assert.equal((await dropped.get("site")).recipe.version, "1.1.0");
  await dropped.close();

  const plainer = await open([recipe("1.3.0", null)]);
  await assert.rejects(plainer.upgrade("site"), /no longer offers/);
  await plainer.close();
});

test("a stored install lock that is malformed is refused when read, never trusted", async () => {
  const { manager, store, open } = await setup();
  await manager.create({ name: "Site", recipeName: "@acme/site", start: false });
  await manager.close();
  for (const damage of [
    (lock) => { lock.driver = "shell"; }, (lock) => { lock.method = "../x"; }, (lock) => { lock.software = "latest"; },
    (lock) => { lock.requires = "nginx"; }, (lock) => { lock.extra = true; }, (lock) => { delete lock.method; },
  ]) {
    const record = (await store.get("projects", "site")).value;
    const broken = JSON.parse(JSON.stringify(record));
    damage(broken.recipe.install);
    await store.set("projects", "site", broken);
    const reopened = await open();
    await assert.rejects(reopened.get("site"), /install lock is malformed/);
    await reopened.close();
    await store.set("projects", "site", record);
  }
});

const withAdoption = (over = {}) => manifest({ adopt: [{ state: "old-state.json", move: { old: "new" }, ports: { web: "port" } }], ...over });

test("a Project of an earlier layout is upgraded to a recipe that can take it over, in two phases", async () => {
  const { manager, state, open, running } = await setup(undefined, [recipe("1.0.0", null)]);
  state.host = { drivers: ["js"], requirements: ["nginx", "php-fpm"] };
  const created = await manager.create({ name: "Old", recipeName: "@acme/site", start: false });
  assert.equal(created.recipe.install, undefined, "made before the recipe had install methods");
  await manager.close();

  const newer = await open([recipe("2.0.0", withAdoption())]);
  const upgraded = await newer.upgrade("old");
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.deepEqual(upgraded.recipe.install, { method: "native", driver: "js", requires: ["nginx", "php-fpm"], software: "7.10.0" });
  assert.deepEqual(running.calls.filter(([kind]) => kind !== "prepare").map(([kind]) => kind), ["commit"], "recorded, so the way back closes");
  assert.deepEqual(running.calls.at(-2), ["prepare", "old", "2.0.0"]);
  await newer.close();
});

test("a recipe that does not say how to take an earlier layout over refuses, and nothing is touched", async () => {
  const { manager, state, open } = await setup(undefined, [recipe("1.0.0", null)]);
  state.host = { drivers: ["js"], requirements: ["nginx", "php-fpm"] };
  await manager.create({ name: "Old", recipeName: "@acme/site", start: false });
  await manager.close();
  const newer = await open([recipe("2.0.0", manifest())]);
  await assert.rejects(newer.upgrade("old"), /does not describe how to take over its files\. Create a new Project/);
  assert.equal((await newer.get("old")).recipe.version, "1.0.0");
  await newer.close();
});

test("when the upgrade cannot be recorded, the driver is told to put the earlier layout back and the earlier recipe is prepared again", async () => {
  const { manager, state, store, running } = await setup(undefined, [recipe("1.0.0", null)]);
  state.host = { drivers: ["js"], requirements: ["nginx", "php-fpm"] };
  await manager.create({ name: "Old", recipeName: "@acme/site", start: false });
  await manager.close();
  const failing = {
    ...store,
    set: async (namespace, key, value) => {
      if (value?.recipe?.version === "2.0.0") throw new Error("store unavailable");
      return store.set(namespace, key, value);
    },
  };
  const newer = await createProjectManager({
    store: new Proxy(store, { get: (target, name) => name === "set" ? failing.set : target[name].bind?.(target) ?? target[name] }),
    projectRecipes: [recipe("2.0.0", withAdoption())], runtime: running.runtime, autoReconcile: false,
    installHost: async () => state.host,
  });
  running.calls.length = 0;
  await assert.rejects(newer.upgrade("old"), /store unavailable/);
  assert.deepEqual(running.calls.map(([kind]) => kind), ["prepare", "abandon", "prepare"], "prepared for the new recipe, abandoned, then the earlier recipe prepared again");
  assert.equal(running.calls.at(-1)[2], "1.0.0");
  assert.equal((await newer.get("old")).recipe.version, "1.0.0", "the Project is as it was");
  await newer.close();
});
