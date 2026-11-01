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
        return { from: 2, to: 4 };
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
