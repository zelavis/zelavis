// A running managed app made by an earlier, hand-written runtime crosses to the recipe that takes its layout
// over: its requests are held while its processes are swapped, none is refused, and a crossing that fails
// puts the earlier recipe back where it was.
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { parseRecipeManifest } from "zelavis/recipe";

const install = {
  contract: 2,
  methods: [{ id: "native", driver: "js", entry: "./recipe.js", requires: [] }],
  software: [{ version: "7.1.2", archive: "https://example.com/7.1.2.tar.gz", sha256: "b".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
  adopt: [{ state: "site-native.json", move: { site: "site" }, ports: { web: "httpPort" } }],
};
const recipe = (version, withInstall) => ({
  service: { name: "@acme/blog", kind: "app", version, api: {}, service: {},
    project: { runtimeKinds: ["native"], managed: { adminTitle: "Blog Admin", adminPath: "/admin/" }, ...(withInstall ? { install: parseRecipeManifest(install) } : {}) } },
  specifier: "@acme/blog", status: "available", source: "official", order: 0,
});

function driver({ failNewStart = false } = {}) {
  const calls = [];
  const state = { running: false, recipe: undefined, during: undefined };
  return {
    calls, state,
    runtime: {
      name: "test-runtime",
      capabilities: () => ({ statelessRuntimeReplicas: false, zeroDowntimeUpdates: true, recipeUpdateMode: "integration", description: "test" }),
      supportsLiveUpdate: () => true,
      async prefetchUpdate(previous, candidate) { calls.push(["prefetch", candidate.recipe.version]); },
      async prepare(project, lock) { calls.push(["prepare", lock.version]); if (state.during) await state.during(); },
      async start(project) {
        calls.push(["start", project.recipe.version]);
        if (failNewStart && project.recipe.install) throw new Error("the new recipe could not start");
        state.running = true; state.recipe = project.recipe.version;
        return { status: "running", url: "http://127.0.0.1:18080" };
      },
      async stop() { calls.push(["stop"]); state.running = false; return { status: "stopped" }; },
      async status() { return state.running ? { status: "running", url: "http://127.0.0.1:18080" } : { status: "stopped" }; },
      async commitUpgrade(id) { calls.push(["commit", id]); },
      async abandonUpgrade(id) { calls.push(["abandon", id]); },
      async prepareUpdate() { throw new Error("a crossing never takes the integration path"); },
      async applyUpdate() { throw new Error("a crossing never takes the integration path"); },
      async recoverUpdate() { return "previous"; },
      async logs() { return []; },
      async destroy() {},
      async close() {},
    },
  };
}

async function runningOldBlog(t, options = {}) {
  const fake = driver(options);
  const store = createMemorySystemStore();
  const entries = [recipe("7.1.3-alpha.2", false)];
  const manager = await createProjectManager({ store, projectRecipes: () => Promise.resolve(entries), runtime: fake.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }) });
  t.after(() => manager.close());
  await manager.create({ id: "blogger", name: "Blogger", recipeName: "@acme/blog" });
  assert.equal((await manager.get("blogger")).runtime.status, "running");
  entries[0] = options.next ?? recipe("7.1.3-alpha.4", true);
  fake.calls.length = 0;
  return { fake, manager, store };
}

test("a running Project of an earlier layout crosses to the recipe that takes it over while its requests wait", async (t) => {
  const { fake, manager, store } = await runningOldBlog(t);
  let released = false;
  const statuses = [];
  // While the new recipe prepares, a visitor arrives: it is held, and the record still says running.
  fake.state.during = async () => {
    statuses.push((await store.get("projects", "blogger")).value.runtime.status);
    manager.ingressReady("blogger").then(() => { released = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(released, false, "a request arriving during the swap waits");
    fake.state.during = undefined;
  };
  const upgraded = await manager.upgrade("blogger");
  assert.deepEqual(fake.calls, [["prefetch", "7.1.3-alpha.4"], ["stop"], ["prepare", "7.1.3-alpha.4"], ["start", "7.1.3-alpha.4"], ["commit", "blogger"]]);
  assert.deepEqual(statuses, ["running"], "the Project never looks stopped to the Platform");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, true, "and goes on once the new recipe runs");
  assert.equal(upgraded.runtime.status, "running");
  assert.equal(upgraded.recipe.version, "7.1.3-alpha.4");
  assert.equal(upgraded.recipe.install?.method, "native", "locked with the install method it now has");
  assert.equal(fake.state.recipe, "7.1.3-alpha.4");
});

test("a crossing that fails puts the earlier recipe back, running, and reports why", async (t) => {
  const { fake, manager } = await runningOldBlog(t, { failNewStart: true });
  await assert.rejects(manager.upgrade("blogger"), /could not start/);
  assert.deepEqual(fake.calls, [["prefetch", "7.1.3-alpha.4"], ["stop"], ["prepare", "7.1.3-alpha.4"], ["start", "7.1.3-alpha.4"],
    ["abandon", "blogger"], ["prepare", "7.1.3-alpha.2"], ["start", "7.1.3-alpha.2"]]);
  const after = await manager.get("blogger");
  assert.equal(after.recipe.version, "7.1.3-alpha.2");
  assert.equal(after.runtime.status, "running", "the site runs again on what it had");
  let released = false;
  await manager.ingressReady("blogger").then(() => { released = true; });
  assert.equal(released, true, "nothing stays held");
});

test("an upgrade to a recipe the Marketplace only lists is refused until it is installed, never run from the listing", async (t) => {
  // What the allow-list says about the package: identity and version, no install methods and no code.
  const listing = { ...recipe("7.1.3-alpha.4", false), status: "available", specifier: "npm:@acme/blog@7.1.3-alpha.4" };
  listing.service = { ...listing.service, marketplace: { title: "Blog" } };
  const { fake, manager } = await runningOldBlog(t, { next: listing });
  await assert.rejects(manager.upgrade("blogger"), /Blog 7\.1\.3-alpha\.4 is listed in the Marketplace but not installed yet\. Install it, then upgrade "blogger"/);
  assert.deepEqual(fake.calls, [], "nothing was prepared, stopped or rewritten");
  assert.equal((await manager.get("blogger")).runtime.status, "running");
});
