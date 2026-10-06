import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";

test("local Project router forwards committed placement to its Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-placement-router-"));
  const projects = join(root, "projects");
  const project = {
    id: "shop", name: "Shop", kind: "zelavis", runtimeKind: "native",
    recipe: { name: "@zelavis/app", version: "1.0.0", specifier: "@zelavis/app" },
  };
  project.recipe.version = JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8")).version;
  project.recipe.runtimeKinds = ["native"];
  const placement = {
    projectId: "shop", nodeId: "node-a", ownerSession: "session-a", epoch: 2,
  };
  const commands = [];
  const agent = {
    name: "test-agent",
    async start(command, callbacks) {
      commands.push(command);
      queueMicrotask(() => callbacks.onOutput?.({ stream: "stdout",
        line: JSON.stringify({ type: "ready", url: "http://127.0.0.1:12345" }) }));
      let running = true;
      return {
        workloadId: command.workloadId,
        get running() { return running; },
        exit: new Promise(() => {}),
        async stop() { running = false; return { code: 0, signal: null, requested: true }; },
      };
    },
    async close() {},
  };
  try {
    const runtime = createLocalProjectRuntime({ directory: projects, agent });
    try {
      await runtime.prepare(project, project.recipe);
      assert.equal((await runtime.start(project, placement)).status, "running");
      assert.deepEqual(commands[0].placement, placement);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
