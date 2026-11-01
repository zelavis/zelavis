// Requests are routed with a view of the Project that does not wait for its lifecycle: a live update
// holds the lifecycle for its whole length, and traffic must keep reaching the serving runtime meanwhile.
import assert from "node:assert/strict";
import test from "node:test";

import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const recipe = { service: { name: "@acme/site", kind: "app", version: "1.0.0", api: {}, service: {}, project: { runtimeKinds: ["native"] } },
  specifier: "@acme/site", status: "available", source: "official", order: 0 };

test("a Project's view and gateway target answer while a lifecycle transition holds it; get waits for the transition", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const running = new Set();
  const runtime = {
    name: "test-runtime",
    capabilities: () => ({ statelessRuntimeReplicas: false, description: "test" }),
    async prepare() {},
    async start(project) {
      starts += 1;
      if (starts === 2) await held;
      running.add(project.id);
      return { status: "running", url: "http://127.0.0.1:1" };
    },
    async stop(id) { running.delete(id); return { status: "stopped" }; },
    async status(id) { return running.has(id) ? { status: "running", url: "http://127.0.0.1:1" } : { status: "stopped" }; },
    async logs() { return []; },
    async destroy() {},
    async close() {},
  };
  const manager = await createProjectManager({ store: createMemorySystemStore(), projectRecipes: [recipe], runtime, autoReconcile: false });
  t.after(() => manager.close());
  await manager.create({ name: "Site", recipeName: "@acme/site" });

  const restarting = manager.restart("site");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const viewed = await Promise.race([manager.view("site"), new Promise((resolve) => setTimeout(() => resolve("waited"), 1000))]);
  assert.notEqual(viewed, "waited", "the view does not wait for the transition");
  assert.equal(viewed.id, "site");
  const targeted = await Promise.race([manager.gatewayTarget("site").then((url) => ({ url })), new Promise((resolve) => setTimeout(() => resolve("waited"), 1000))]);
  assert.notEqual(targeted, "waited", "the gateway target of a Project that is not a managed app does not wait for the transition");
  let got = false;
  const reading = manager.get("site").then((project) => { got = true; return project; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(got, false, "a locked read waits for the transition");
  release();
  await restarting;
  assert.equal((await reading).runtime.status, "running");
});
