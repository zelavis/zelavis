// The whole path: a Project created from one version of a recipe, running, is upgraded through the
// Project manager to the next version while serving traffic, and the Platform restarts afterwards
// on what was committed.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { parseRecipeManifest } from "zelavis/recipe";

const MANIFEST = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }, { name: "db", protocol: "tcp" }],
};

const RECIPE = (message) => `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
const SERVER = ${JSON.stringify(`
const fs = require("node:fs"), http = require("node:http");
const [name, port, configFile] = process.argv.slice(2);
const read = () => { try { return fs.readFileSync(configFile, "utf8"); } catch { return "none"; } };
let current = read();
process.on("SIGHUP", () => { current = read(); });
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ name, pid: process.pid, config: current }))).listen(Number(port), "127.0.0.1");
setInterval(() => {}, 1000);
`)};
export default defineRecipe({
  install: () => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("web.conf", ${JSON.stringify(message)});
    yield* host.files.write("server.js", SERVER);
  }),
  start: (context) => Effect.succeed({ processes: [
    { name: "db", command: "node", args: [context.directories.root + "/server.js", "db", String(context.ports.db), "-"], env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 4000 } },
    { name: "web", command: "node", args: [context.directories.root + "/server.js", "web", String(context.ports.web), context.directories.root + "/web.conf"], env: {}, dependsOn: ["db"],
      readiness: { port: "web", timeoutMs: 4000 }, config: [context.directories.root + "/web.conf"], update: { strategy: "reload", signal: "SIGHUP" } },
  ] }),
});
`;

async function recipePackage(base, version, message) {
  const directory = join(base, `package-${version}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/live", version, type: "module", exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", namespace: "acmelive", project: { runtimeKinds: ["native"], runtime: "./dist/runtime.js", install: MANIFEST } },
  }));
  await writeFile(join(directory, "dist", "index.js"), "export function register() {}");
  await writeFile(join(directory, "dist", "recipe.mjs"), RECIPE(message));
  await writeFile(join(directory, "dist", "runtime.js"), `import { createRecipeProjectRuntime } from "zelavis/adapters/project-runtime";
export function createProjectRuntime(context) {
  return createRecipeProjectRuntime({ name: "recipe-live", description: "live recipe", directory: context.directory,
    packageDirectory: context.packageDirectory, agent: context.agent, recipes: context.recipes });
}
`);
  return directory;
}

const entry = (version) => ({
  service: { name: "@acme/live", kind: "app", version, api: {}, service: {}, marketplace: { title: "Live" }, project: { runtimeKinds: ["native"], install: parseRecipeManifest(MANIFEST) } },
  specifier: "@acme/live", status: "available", source: "official", order: 0,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a running Project is upgraded through the manager with traffic flowing, and the Platform then restarts on the committed recipe", { timeout: 40_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zv-live-platform-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sources = { "1.0.0": await recipePackage(base, "1.0.0", "from version one"), "2.0.0": await recipePackage(base, "2.0.0", "from version two") };
  const projects = join(base, "projects");
  const store = createMemorySystemStore();
  let latest = "1.0.0";

  const platform = (recipeVersion) => {
    latest = recipeVersion;
    const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
    const runtime = createLocalProjectRuntime({
      directory: projects, agent,
      recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/live" ? sources[version ?? latest] : undefined },
    });
    const manager = createProjectManager({
      store, projectRecipes: [entry(recipeVersion)], runtime, autoReconcile: false,
      installHost: async () => ({ drivers: ["js"], requirements: ["node"] }),
    });
    // Whatever happens in the test, nothing it started outlives it.
    t.after(async () => { await runtime.close().catch(() => undefined); await agent.close(); });
    return { agent, runtime, manager };
  };

  // Platform 1 ships recipe 1.0.0: create the Project and let it run.
  const first = await platform("1.0.0");
  const created = await (await first.manager).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  assert.equal(created.runtime.status, "running");
  const state = JSON.parse(readFileSync(join(projects, "live", ".zelavis", "recipe-state.json"), "utf8"));
  const ask = async (name) => (await fetch(`http://127.0.0.1:${state.ports[name]}/`)).json();
  const before = { web: await ask("web"), db: await ask("db") };
  assert.equal(before.web.config, "from version one");

  // The Platform now ships 2.0.0 (the same process, a new manager over the same store and runtime).
  const manager = await createProjectManager({
    store, projectRecipes: [entry("2.0.0")], runtime: first.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: ["node"] }),
  });
  latest = "2.0.0";
  const stale = await manager.get("live");
  assert.equal(stale.recipeStatus.state, "upgradeAvailable");

  let stop = false; let failures = 0; let served = 0;
  const traffic = (async () => { while (!stop) { try { await ask("web"); served += 1; } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  const upgraded = await manager.upgrade("live", { restart: true });
  await sleep(100);
  stop = true; await traffic;

  assert.equal(failures, 0, "not one request failed while the running Project changed recipe");
  assert.ok(served > 30);
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "running", "never stopped");
  assert.equal(upgraded.runtimeUpdate, undefined, "the durable intent is cleared");
  assert.equal(upgraded.recipeStatus.state, "current");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.deepEqual([after.web.pid, after.db.pid], [before.web.pid, before.db.pid], "the same processes, not restarted even though restart was allowed");
  assert.equal(after.web.config, "from version two");
  assert.equal(upgraded.recipe.artifact.digest, await digestArtifactDirectory(join(projects, "live", ".zelavis", "recipe", "package")), "the lock and the frozen copy agree");
  assert.equal(existsSync(join(projects, "live", ".zelavis", "upgrade")), false);
  await manager.close();
  await first.agent.close();

  // A later Platform start (processes are gone with the old one) comes up on the committed recipe.
  const second = await platform("2.0.0");
  const restarted = await (await second.manager).start("live");
  assert.equal(restarted.recipe.version, "2.0.0");
  assert.equal(restarted.runtime.status, "running");
  assert.equal((await ask("web")).config, "from version two");
  await (await second.manager).close();
  await second.agent.close();
});
