// Several recipes run side by side, and a Platform that restarts adopts each Project with its own recipe.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { entry, soloEntry, soloPackage, sourcesIn } from "./fixtures/managed-live.mjs";

test("a runtime adopts only the Projects of its own recipe, so two differently shaped recipes coexist across a Platform restart", { timeout: 90_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zv-recipes-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sources = await sourcesIn(base);
  const solo = await soloPackage(base);
  const projects = join(base, "projects");
  const store = createMemorySystemStore();
  // The Agent is separately supervised: it, and what it runs, outlive the Platform that started them.
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
  const kept = new Map();
  const agent = { ...runner, survivesControlPlaneRestart: true,
    start: async (command, options) => {
      let listener = options?.onOutput;
      const child = await runner.start(command, { ...options, onOutput: (line) => listener?.(line) });
      const adoptable = Object.assign(child, { listen: (handler) => { listener = handler; } });
      kept.set(command.workloadId, [...(kept.get(command.workloadId) ?? []), { process: adoptable, command: { workloadId: command.workloadId, executable: command.executable, args: command.args, cwd: command.cwd }, replay: [] }]);
      return adoptable;
    },
    attach: async (id) => kept.get(id) ?? [] };
  const platform = () => {
    const runtime = createLocalProjectRuntime({ directory: projects, agent,
      recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/solo" ? solo : sources[version ?? "1.0.0"] } });
    const manager = createProjectManager({ store, projectRecipes: [entry("1.0.0"), soloEntry()], runtime, autoReconcile: false,
      installHost: async () => ({ drivers: ["js"], requirements: ["node"] }) });
    return { runtime, manager };
  };
  const first = platform();
  t.after(async () => { await first.runtime.close().catch(() => undefined); await runner.close(); });
  const manager = await first.manager;
  await manager.create({ name: "Live", id: "live", recipeName: "@acme/live" });
  await manager.create({ name: "Solo", id: "solo", recipeName: "@acme/solo" });
  const ask = (id, name) => {
    const state = JSON.parse(readFileSync(join(projects, id, ".zelavis", "recipe-state.json"), "utf8"));
    return fetch(`http://127.0.0.1:${state.ports[name]}/`).then((response) => response.json());
  };
  const before = { live: await ask("live", "web"), solo: await ask("solo", "web") };

  // The solo recipe's runtime, asked to adopt in a directory that also holds the other recipe's Project, adopts
  // only its own: judging foreign processes by this manifest (no "db" port) would refuse them.
  const alone = createRecipeProjectRuntime({ name: "solo-only", description: "solo", directory: projects, packageDirectory: solo, agent });
  t.after(() => alone.close().catch(() => undefined));
  await alone.adopt();
  assert.equal((await alone.status("solo")).status, "running", "its own Project is adopted");
  assert.equal((await alone.status("live")).status, "stopped", "the other recipe's Project is left to its own runtime");

  // A Platform that starts over the same Agent adopts what runs, each Project judged by its own recipe.
  const second = platform();
  t.after(() => second.runtime.close().catch(() => undefined));
  await second.runtime.adopt();
  const restarted = await second.manager;
  for (const id of ["live", "solo"]) {
    assert.equal((await second.runtime.status(id)).status, "running", `${id} is adopted with its own recipe`);
    assert.equal((await ask(id, "web")).pid, before[id].pid, `${id}: adopted, not restarted`);
  }
  // And a restarted Platform can still upgrade or stop what it adopted.
  assert.equal((await restarted.stop("solo")).runtime.status, "stopped");
  assert.equal((await restarted.get("live")).runtime.status, "running");
});
