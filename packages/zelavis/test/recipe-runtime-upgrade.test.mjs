// A recipe that brings its own program (here a tiny server) is upgraded, while running, to a version that
// brings another build of it: the Project goes on serving with no failed request, the new build is the one
// that runs, and an upgrade whose build cannot be had leaves the Project exactly as it was.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { runtimePlatform } from "../dist/adapters/_recipe-runtimes.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { parseRecipeManifest } from "../dist/core/recipe/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SERVER = (build) => `#!/usr/bin/env node
const http = require("node:http");
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ build: ${JSON.stringify(build)}, pid: process.pid }))).listen(Number(process.argv[2]), "127.0.0.1");
setInterval(() => {}, 1000);
`;

async function build(base, name) {
  const source = join(base, `build-${name}`);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "serve"), SERVER(name), { mode: 0o755 });
  const archive = join(base, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "serve"]);
  const bytes = await readFile(archive);
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const manifestFor = (download) => ({
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: [] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
  runtimes: [{ command: "serve", version: "1.0.0", downloads: { [runtimePlatform()]: { archive: `https://builds.example/${download.name}.tar.gz`, sha256: download.sha256, maxBytes: download.bytes.length + 1024, executable: "serve" } } }],
});

const RECIPE = `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
export default defineRecipe({
  install: () => Effect.gen(function* () { const host = yield* RecipeHost; yield* host.files.write("installed", "yes"); }),
  start: (context) => Effect.succeed({ processes: [
    { name: "web", command: "serve", args: [String(context.ports.web)], env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 8000 } },
  ] }),
});
`;

async function recipePackage(base, version, download) {
  const directory = join(base, `package-${version}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/runtime", version, type: "module", exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", namespace: "acmeruntime", project: { runtimeKinds: ["native"], runtime: "./dist/runtime.js", install: manifestFor(download) } },
  }));
  await writeFile(join(directory, "dist", "index.js"), "export function register() {}");
  await writeFile(join(directory, "dist", "recipe.mjs"), RECIPE);
  await writeFile(join(directory, "dist", "runtime.js"), `import { createRecipeProjectRuntime } from "zelavis/adapters/project-runtime";
export function createProjectRuntime(context) {
  return createRecipeProjectRuntime({ name: "acme-runtime", description: "runtime recipe", directory: context.directory,
    packageDirectory: context.packageDirectory, agent: context.agent, recipes: context.recipes });
}
`);
  return directory;
}
const entry = (version, download) => ({
  service: { name: "@acme/runtime", kind: "app", version, api: {}, service: {}, marketplace: { title: "Runtime" },
    project: { runtimeKinds: ["native"], install: parseRecipeManifest(manifestFor(download)) } },
  specifier: "@acme/runtime", status: "available", source: "official", order: 0,
});

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "zv-runtime-upgrade-"));
  const builds = { a: await build(base, "a"), b: await build(base, "b") };
  const bad = { ...builds.b, name: "b", sha256: "f".repeat(64) };
  const sources = { "1.0.0": await recipePackage(base, "1.0.0", builds.a), "2.0.0": await recipePackage(base, "2.0.0", builds.b), "3.0.0": await recipePackage(base, "3.0.0", bad) };
  const downloads = { "1.0.0": builds.a, "2.0.0": builds.b, "3.0.0": bad };
  const served = new Map([["https://builds.example/a.tar.gz", builds.a.bytes], ["https://builds.example/b.tar.gz", builds.b.bytes]]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const bytes = served.get(String(url));
    return bytes ? new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } }) : realFetch(url, init);
  };
  const projects = join(base, "projects");
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
  const runtime = createLocalProjectRuntime({ directory: projects, agent,
    recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/runtime" ? sources[version ?? "1.0.0"] : undefined } });
  t.after(async () => { globalThis.fetch = realFetch; await runtime.close().catch(() => undefined); await agent.close(); await rm(base, { recursive: true, force: true }); });
  const managerFor = (version) => createProjectManager({ store: createMemorySystemStore(), projectRecipes: [entry(version, downloads[version])], runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }) });
  return { base, projects, managerFor, builds, entry, downloads, runtime };
}

test("a running Project upgrades to a recipe that brings another build of its program: no request fails, and the new build runs", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const store = createMemorySystemStore();
  const manager = async (version) => createProjectManager({ store, projectRecipes: [f.entry(version, f.downloads[version])], runtime: f.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }) });
  const first = await manager("1.0.0");
  await first.create({ name: "R", id: "r", recipeName: "@acme/runtime" });
  const state = () => JSON.parse(readFileSync(join(f.projects, "r", ".zelavis", "recipe-state.json"), "utf8"));
  const ask = () => fetch(`http://127.0.0.1:${state().ports.web}/`).then((response) => response.json());
  const before = await ask();
  assert.equal(before.build, "a");
  assert.equal(state().commands.serve, join(f.projects, "..", "runtimes", f.builds.a.sha256, "serve"), "the program lies in the Platform's store, not on the host");

  const second = await manager("2.0.0");
  let stop = false, failed = 0, served = 0; const seen = new Set();
  // As a reverse proxy does for a GET whose connection is refused: wait at the gate again and try once more.
  const request = async () => { await second.ingressReady("r"); return (await ask()).build; };
  const through = (async () => { while (!stop) { try { seen.add(await request().catch(() => request())); served += 1; } catch { failed += 1; } await sleep(5); } })();
  await sleep(150);
  const upgraded = await second.upgrade("r", {});
  await sleep(150);
  stop = true; await through;

  assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(upgraded.runtime.status, "running");
  const after = await ask();
  assert.equal(after.build, "b", "the new recipe's build is the one running");
  assert.notEqual(after.pid, before.pid, "a different program is a replaced process");
  assert.equal(state().commands.serve, join(f.projects, "..", "runtimes", f.builds.b.sha256, "serve"));
  assert.equal(failed, 0, "requests wait at the gate while the program is replaced; none fail");
  assert.ok(served > 10 && seen.has("a") && seen.has("b"), `served ${served} from ${[...seen]}`);
  assert.ok(existsSync(join(f.projects, "..", "runtimes", f.builds.a.sha256, "serve")), "the previous build is kept for rollback and for other Projects");
  await second.close();
});

test("an upgrade whose build cannot be had is refused before anything changes", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const store = createMemorySystemStore();
  const manager = async (version) => createProjectManager({ store, projectRecipes: [f.entry(version, f.downloads[version])], runtime: f.runtime, autoReconcile: false,
    installHost: async () => ({ drivers: ["js"], requirements: [] }) });
  await (await manager("1.0.0")).create({ name: "R", id: "r", recipeName: "@acme/runtime" });
  const state = () => JSON.parse(readFileSync(join(f.projects, "r", ".zelavis", "recipe-state.json"), "utf8"));
  const ask = () => fetch(`http://127.0.0.1:${state().ports.web}/`).then((response) => response.json());
  const before = await ask();

  const third = await manager("3.0.0");
  await assert.rejects(third.upgrade("r", {}), /could not be downloaded|does not match/);
  const project = await third.get("r");
  assert.equal(project.recipe.version, "1.0.0");
  assert.equal(project.runtime.status, "running");
  assert.equal(project.runtimeUpdate, undefined);
  assert.deepEqual(await ask(), before, "the same process, still serving the build it had");
  assert.equal(existsSync(join(f.projects, "r", ".zelavis", "upgrade")), false, "nothing is left staged");
  await third.close();
});
