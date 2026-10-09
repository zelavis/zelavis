// The managed path: a Project created from one version of a recipe, running, is upgraded through the
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
    zelavis: { kind: "app", namespace: "acmelive", project: { runtimeKinds: ["native"], runtime: "./dist/runtime.js", install: MANIFEST, managed: { adminTitle: "Live admin " + version, adminPath: "/admin/" } } },
  }));
  await writeFile(join(directory, "dist", "index.js"), `import { zelavis } from "zelavis/sdk";
export function register() {
  zelavis.plugins.ui.menus.create({ title: "Integration ${version}", path: "/integration", surface: "root" });
}`);
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
  service: { name: "@acme/live", kind: "app", version, api: {}, service: {}, marketplace: { title: "Live" },
    project: { runtimeKinds: ["native"], install: parseRecipeManifest(MANIFEST), managed: { adminTitle: "Live admin " + version, adminPath: "/admin/" } } },
  specifier: "@acme/live", status: "available", source: "official", order: 0,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, rejectTarget) {
  const base = await mkdtemp(join(tmpdir(), "zv-managed-live-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const sources = { "1.0.0": await recipePackage(base, "1.0.0", "from version one"), "2.0.0": await recipePackage(base, "2.0.0", "from version two") };
  const projects = join(base, "projects");
  const memory = createMemorySystemStore();
  // The Platform's registry can be made to refuse the commit of the new recipe.
  const store = new Proxy(memory, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== "function") return value;
    return (...args) => {
      const record = args.find((argument) => argument && typeof argument === "object" && "recipe" in argument);
      if (rejectTarget.on && record?.recipe?.version === "2.0.0" && record.runtimeUpdate && !record.runtimeUpdate.error) throw new Error("registry rejected the commit");
      return value.apply(target, args);
    };
  } });
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
  const runtime = createLocalProjectRuntime({
    directory: projects, agent,
    recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/live" ? sources[version ?? "1.0.0"] : undefined },
  });
  t.after(async () => { await runtime.close().catch(() => undefined); await agent.close(); });
  const managerFor = (version) => createProjectManager({ store, projectRecipes: [entry(version)], runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: ["node"] }) });
  return { projects, store, runtime, managerFor };
}

const web = (projects) => {
  const state = JSON.parse(readFileSync(join(projects, "live", ".zelavis", "recipe-state.json"), "utf8"));
  return (name) => fetch(`http://127.0.0.1:${state.ports[name]}/`).then((response) => response.json());
};
const descriptor = (projects) => JSON.parse(readFileSync(join(projects, "live", "project.json"), "utf8"));

test("a running managed Project upgrades its integration and its processes in one transaction, and nothing stops", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { on: false });
  const created = await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  assert.equal(created.runtime.status, "running");
  const ask = web(f.projects);
  const before = { web: await ask("web"), db: await ask("db") };
  assert.equal(before.web.config, "from version one");

  const manager = await f.managerFor("2.0.0");
  assert.equal((await manager.get("live")).recipeStatus.state, "upgradeAvailable");
  let stop = false, failures = 0, served = 0;
  const traffic = (async () => { while (!stop) { try { await ask("web"); served += 1; } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  const upgraded = await manager.upgrade("live", {});
  await sleep(100);
  stop = true; await traffic;

  assert.equal(failures, 0, "not one request failed");
  assert.ok(served > 30);
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "running");
  assert.equal(upgraded.runtimeUpdate, undefined);
  const after = { web: await ask("web"), db: await ask("db") };
  assert.deepEqual([after.web.pid, after.db.pid], [before.web.pid, before.db.pid], "the app's processes were not restarted");
  assert.equal(after.web.config, "from version two", "the processes follow the new recipe's configuration");
  assert.equal(descriptor(f.projects).recipe.version, "2.0.0", "the integration host's descriptor is the new recipe");
  assert.equal(descriptor(f.projects).recipe.managed.adminTitle, "Live admin 2.0.0");
  assert.equal(upgraded.recipe.artifact.digest, await digestArtifactDirectory(join(f.projects, "live", ".zelavis", "recipe", "package")));
  assert.equal(existsSync(join(f.projects, "live", ".zelavis", "upgrade")), false, "the workload's journal is gone");
  await manager.close();
});

test("when the registry refuses the commit, the processes, their configuration and the integration all return to the previous recipe", { timeout: 90_000 }, async (t) => {
  const rejecting = { on: false };
  const f = await fixture(t, rejecting);
  await (await f.managerFor("1.0.0")).create({ name: "Live", id: "live", recipeName: "@acme/live" });
  const ask = web(f.projects);
  const before = { web: await ask("web"), db: await ask("db") };

  const manager = await f.managerFor("2.0.0");
  rejecting.on = true;
  let failures = 0, stop = false; const seen = new Set();
  const traffic = (async () => { while (!stop) { try { seen.add((await ask("web")).config); } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  await assert.rejects(manager.upgrade("live", {}), /registry rejected/);
  rejecting.on = false;
  await sleep(100);
  stop = true; await traffic;

  const project = await manager.get("live");
  assert.equal(project.recipe.version, "1.0.0");
  assert.equal(project.runtime.status, "running");
  assert.equal(project.runtimeUpdate, undefined, "the failed update was recovered, not left pending");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.equal(after.web.config, "from version one", "the configuration was put back and the process reloaded it");
  assert.equal(after.db.pid, before.db.pid);
  assert.equal(descriptor(f.projects).recipe.version, "1.0.0");
  assert.equal(existsSync(join(f.projects, "live", ".zelavis", "upgrade")), false);
  assert.equal(failures, 0, "the rolled-back upgrade also served every request");
  assert.ok(seen.has("from version two"), "the new configuration really was live before the commit was refused");
  await manager.close();
});

test("a managed Project upgraded while stopped prepares the app for the new recipe when it next starts", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { on: false });
  const first = await f.managerFor("1.0.0");
  await first.create({ name: "Live", id: "live", recipeName: "@acme/live" });
  await first.stop("live");
  const manager = await f.managerFor("2.0.0");
  const upgraded = await manager.upgrade("live", {});
  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "stopped");
  const started = await manager.start("live");
  assert.equal(started.runtime.status, "running");
  assert.equal((await web(f.projects)("web")).config, "from version two", "install ran for the new recipe before the app started");
  assert.equal(JSON.parse(readFileSync(join(f.projects, "live", ".zelavis", "recipe-state.json"), "utf8")).installedFor, started.recipe.artifact.digest);
  await manager.close();
});
