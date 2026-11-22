// A managed app's bound App can hold data in an earlier layout than the Platform writes. The Project says so, and its upgrade
// brings the data forward first, whether or not its recipe changed; a failed migration changes nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const recipe = (version) => ({
  service: { name: "@acme/blog", kind: "app", version, api: {}, service: {}, project: { runtimeKinds: ["native"], managed: { adminTitle: "Blog Admin", adminPath: "/admin/" } } },
  specifier: "@acme/blog", status: "available", source: "official", order: 0,
});

function driver({ failMigration = false } = {}) {
  const calls = [];
  const layout = { value: 2 };
  let running = false;
  return {
    calls, layout,
    runtime: {
      name: "test-runtime",
      capabilities: () => ({ statelessRuntimeReplicas: false, zeroDowntimeUpdates: true, recipeUpdateMode: "integration", description: "test" }),
      supportsLiveUpdate: () => true,
      async versions() { return { selectable: false, reason: "managed", versions: [], currentDataFormat: layout.value, latestDataFormat: 4 }; },
      async migrateData(project) {
        calls.push(["migrateData", project.id]);
        if (failMigration) throw new Error("the bound App would not start on the new engine");
        if (layout.value === 4) return undefined;
        layout.value = 4;
        return { from: 2, to: 4, tenants: 2, collections: 3, documents: 40, eventsCarried: 52, tenantsWithoutHistory: 0, documentsWithHistoryDropped: 5, retained: "data.format-2-20261101T000000Z" };
      },
      async prepare() { calls.push(["prepare"]); },
      async start() { running = true; return { status: "running", url: "http://127.0.0.1:18080" }; },
      async stop() { running = false; return { status: "stopped" }; },
      async status() { return running ? { status: "running", url: "http://127.0.0.1:18080" } : { status: "stopped" }; },
      async prepareUpdate() { calls.push(["prepareUpdate"]); throw new Error("a data migration alone is not a recipe update"); },
      async applyUpdate() { calls.push(["applyUpdate"]); throw new Error("not reached"); },
      async recoverUpdate() { return "previous"; },
      async logs() { return []; }, async destroy() {}, async close() {},
    },
  };
}

async function managed(t, options) {
  const fake = driver(options);
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  fake.calls.length = 0;
  return { fake, manager };
}

test("a managed app with data in an earlier layout says so, and its upgrade migrates it even when its recipe is current", async (t) => {
  const { fake, manager } = await managed(t);
  assert.deepEqual((await manager.get("blogger")).dataLayout, { state: "upgradeRequired", from: 2, to: 4 });
  assert.equal((await manager.list())[0].dataLayout?.to, 4, "the list says it too");

  const after = await manager.upgrade("blogger", { restart: true });
  assert.deepEqual(fake.calls, [["migrateData", "blogger"]], "only the migration: no recipe update, nothing to prepare");
  assert.equal(after.dataLayout, undefined);
  assert.deepEqual(after.dataMigration, { from: 2, to: 4, tenants: 2, collections: 3, documents: 40, eventsCarried: 52, tenantsWithoutHistory: 0, documentsWithHistoryDropped: 5, retained: "data.format-2-20261101T000000Z" }, "the response says what changed");
  assert.equal((await manager.get("blogger")).dataMigration, undefined, "and it is not stored");
  assert.equal(after.runtime.status, "running");
  assert.equal((await manager.get("blogger")).dataLayout, undefined, "the card stops offering it once migrated");
});

test("a managed app already in the Platform's layout is not offered a migration", async (t) => {
  const { fake, manager } = await managed(t);
  fake.layout.value = 4;
  assert.equal((await manager.get("blogger")).dataLayout, undefined);
});

test("a failed migration changes nothing and the Project still offers it", async (t) => {
  const { fake, manager } = await managed(t, { failMigration: true });
  await assert.rejects(manager.upgrade("blogger", { restart: true }), /would not start/);
  assert.equal(fake.layout.value, 2);
  const after = await manager.get("blogger");
  assert.equal(after.runtime.status, "running");
  assert.deepEqual(after.dataLayout, { state: "upgradeRequired", from: 2, to: 4 });
});

test("retained data is listed and removed through the Project manager, and a runtime that keeps none says so", async (t) => {
  const kept = new Map([["data.format-2-20261101T000000Z", { name: "data.format-2-20261101T000000Z", kind: "replaced-by-migration", bytes: 123 }]]);
  const fake = driver();
  fake.runtime.retainedData = async () => [...kept.values()];
  fake.runtime.removeRetainedData = async (_id, name) => { if (!kept.delete(name)) { const error = new Error("does not exist"); error._tag = "DataSwapFailure"; throw error; } };
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  assert.deepEqual((await manager.retainedData("blogger")).map((entry) => entry.bytes), [123]);
  await manager.removeRetainedData("blogger", "data.format-2-20261101T000000Z");
  assert.deepEqual(await manager.retainedData("blogger"), []);
  await assert.rejects(manager.removeRetainedData("blogger", "data.format-2-20261101T000000Z"), /does not exist/);
  await assert.rejects(manager.retainedData("nobody"), /not found|No such|does not exist/i);
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for condition");
}

test("reconcile() automatically migrates a managed app's older integration layout in the background without restarting the app", async (t) => {
  const fake = driver();
  fake.runtime.prepareData = async (project) => { fake.calls.push(["prepareData", project.id]); };
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  fake.calls.length = 0;

  assert.deepEqual((await manager.get("blogger")).dataLayout, { state: "upgradeRequired", from: 2, to: 4 });
  await manager.reconcile();
  await waitFor(async () => (await manager.get("blogger")).dataLayout === undefined);

  assert.equal(fake.layout.value, 4);
  assert.deepEqual(fake.calls, [["prepareData", "blogger"], ["migrateData", "blogger"]], "runs prepareData + migrateData without recipe update or restart");
  assert.equal((await manager.get("blogger")).runtime.status, "running");
});

test("failed automatic migration surfaces error on dataLayout, backs off on immediate reconcile, and recovers via dataLayoutOnly retry", async (t) => {
  let shouldFail = true;
  const fake = driver();
  const baseMigrate = fake.runtime.migrateData;
  fake.runtime.migrateData = async (project) => {
    fake.calls.push(["migrateData", project.id]);
    if (shouldFail) throw new Error("bound engine verification failed");
    return baseMigrate.call(fake.runtime, project);
  };
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  fake.calls.length = 0;

  await manager.reconcile();
  const failed = await waitFor(async () => {
    const project = await manager.get("blogger");
    return project.dataLayout?.autoMigration?.state === "failed" ? project : undefined;
  });
  assert.deepEqual(failed.dataLayout, {
    state: "upgradeRequired",
    from: 2,
    to: 4,
    autoMigration: { state: "failed", error: "bound engine verification failed" },
  });
  assert.equal(fake.calls.length, 1);

  // Immediate reconcile respects backoff and does not spam migrateData.
  await manager.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.calls.length, 1);

  // Explicit retry clears the failure and migrates.
  shouldFail = false;
  const retried = await manager.upgrade("blogger", { restart: true, dataLayoutOnly: true });
  assert.equal(retried.dataLayout, undefined);
  assert.equal(retried.dataMigration?.to, 4);
  assert.equal((await manager.get("blogger")).dataLayout, undefined);
});

test("dataLayoutOnly migrates only integration data even when a newer recipe is available, and rejects invalid combinations", async (t) => {
  let currentRecipeVersion = "1.0.0";
  const fake = driver();
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe(currentRecipeVersion)]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  currentRecipeVersion = "2.0.0";
  fake.calls.length = 0;

  await assert.rejects(manager.upgrade("blogger", { dataLayoutOnly: true, recipeName: "@acme/blog" }), /cannot be combined/);

  const after = await manager.upgrade("blogger", { restart: true, dataLayoutOnly: true });
  assert.equal(after.dataLayout, undefined);
  assert.equal(after.dataMigration?.to, 4);
  assert.equal(after.recipe.version, "1.0.0", "recipe version stays untouched on dataLayoutOnly retry");
  assert.deepEqual(fake.calls, [["migrateData", "blogger"]]);
});

test("concurrent upgrade() awaits an in-flight automatic migration without conflict", async (t) => {
  const fake = driver();
  let release;
  const started = new Promise((resolve) => {
    const baseMigrate = fake.runtime.migrateData;
    fake.runtime.migrateData = async (project) => {
      if (fake.layout.value === 2) {
        resolve();
        await new Promise((done) => { release = done; });
      }
      return baseMigrate.call(fake.runtime, project);
    };
  });
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  fake.calls.length = 0;

  await manager.reconcile();
  await started;
  assert.equal((await manager.get("blogger")).dataLayout?.autoMigration?.state, "running");

  const upgradePromise = manager.upgrade("blogger", { restart: true, dataLayoutOnly: true });
  release();
  const after = await upgradePromise;
  assert.equal(after.dataLayout, undefined);
  assert.equal(fake.layout.value, 4);
});

test("reconcile() never auto-migrates backwards when bound data layout is newer than the Platform's", async (t) => {
  const fake = driver();
  fake.layout.value = 6;
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: () => Promise.resolve([recipe("1.0.0")]), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }), synchronizeIngress: async () => ({ status: "ready", port: 18081 }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  fake.calls.length = 0;

  await manager.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.layout.value, 6);
});
