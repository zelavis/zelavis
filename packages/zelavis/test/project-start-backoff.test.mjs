// A Project that cannot start is not prepared and failed again on every reconciliation: automatic
// starts back off after each failure, and an operator's action on the Project tries again at once.
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const recipe = { service: { name: "@acme/site", kind: "app", version: "1.0.0", api: {}, service: {}, project: { runtimeKinds: ["native"] } },
  specifier: "@acme/site", status: "available", source: "official", order: 0 };

function runtime() {
  const state = { starts: 0, healthy: false, running: new Set() };
  state.driver = {
    name: "test-runtime",
    capabilities: () => ({ statelessRuntimeReplicas: false, description: "test" }),
    async prepare() {},
    async start(project) {
      state.starts += 1;
      if (!state.healthy) throw new Error("this recipe cannot run on this host");
      state.running.add(project.id);
      return { status: "running", url: "http://127.0.0.1:1" };
    },
    async stop(id) { state.running.delete(id); return { status: "stopped" }; },
    async status(id) { return state.running.has(id) ? { status: "running", url: "http://127.0.0.1:1" } : { status: "stopped" }; },
    async logs() { return []; },
    async destroy() {},
    async close() {},
  };
  return state;
}

test("automatic starts of a Project that keeps failing back off; an operator start tries again at once", async (t) => {
  const state = runtime();
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: [recipe], runtime: state.driver, autoReconcile: false });
  t.after(() => manager.close());
  // A failed start leaves the Project wanted running, which is what reconciliation retries.
  await manager.create({ name: "Site", recipeName: "@acme/site", start: false });
  await assert.rejects(manager.start("site"), /cannot run on this host/);
  assert.equal(state.starts, 1);
  const failed = await manager.get("site");
  assert.equal(failed.desiredState, "running");
  assert.equal(failed.runtime.status, "failed");
  assert.match(failed.runtime.error, /cannot run on this host/, "the reason stays on the Project");

  await manager.reconcile();
  assert.equal(state.starts, 2, "the first reconciliation tries");
  await manager.reconcile();
  await manager.reconcile();
  assert.equal(state.starts, 2, "and the next ones wait instead of failing again straight away");

  state.healthy = true;
  assert.equal((await manager.start("site")).runtime.status, "running", "the operator's start is not held back");
  assert.equal(state.starts, 3);
});

test("a successful automatic start clears the backoff", async (t) => {
  const state = runtime();
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: [recipe], runtime: state.driver, autoReconcile: false });
  t.after(() => manager.close());
  await manager.create({ name: "Site", recipeName: "@acme/site", start: false });
  await assert.rejects(manager.start("site"));
  await manager.reconcile();
  assert.equal(state.starts, 2);
  // An operator action clears the wait; reconciliation then succeeds and leaves nothing behind.
  state.healthy = true;
  await manager.update("site", { name: "Site" });
  await manager.reconcile();
  assert.equal(state.starts, 3);
  assert.equal((await manager.get("site")).runtime.status, "running");
  await manager.stop("site");
  await manager.start("site");
  assert.equal(state.starts, 4);
});
