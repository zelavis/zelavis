// The generic recipe runtime with a small recipe that needs only Node: lifecycle, install-once,
// stop and interruption behaviour, adoption after a restart, and refusal of the unsupported.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Fiber } from "effect";

import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { effectOperations } from "../dist/core/runtime/effect-boundary.js";
import { loopbackPortAccepts } from "../dist/adapters/_loopback-probe.js";

const MANIFEST = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
};

const RECIPE = (startupDelayMs) => `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.progress({ phase: "install", message: "writing the server" });
    const marker = (yield* host.files.exists("installs.log")) ? yield* host.files.read("installs.log") : "";
    yield* host.files.write("installs.log", marker + "install\\n");
    yield* host.files.write("server.js", "setTimeout(() => require('node:net').createServer((s) => { s.on('error', () => {}); s.end('hi'); }).listen(Number(process.argv[2]), '127.0.0.1'), ${startupDelayMs}); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
  }),
  start: (context) => Effect.succeed({ processes: [{
    name: "web", command: "node", args: [context.directories.root + "/server.js", String(context.ports.web)], env: {}, dependsOn: [],
    readiness: { port: "web", timeoutMs: 8000 },
  }] }),
  stop: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("stopped.log", "stopped\\n");
  }),
  remove: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("removed.log", "removed\\n");
  }),
});
`;

async function recipePackage(base, startupDelayMs = 0) {
  const packageDirectory = join(base, "recipe-package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@acme/node-site", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"], install: MANIFEST } } }));
  await writeFile(join(packageDirectory, "recipe.mjs"), RECIPE(startupDelayMs));
  return packageDirectory;
}

const record = (id, over = {}) => ({
  id, name: id, kind: "node-site", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  recipe: { name: "@acme/node-site", title: "Site", version: "1.0.0", specifier: "@acme/node-site", runtimeKinds: ["native"], install: { method: "native", driver: "js", requires: ["node"], software: "1.0" }, ...over },
});

async function setup(t, { startupDelayMs = 0, agent } = {}) {
  const base = await mkdtemp(join(tmpdir(), "zv-recipe-runtime-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const chosen = agent?.(runner) ?? runner;
  const packageDirectory = await recipePackage(base, startupDelayMs);
  const make = (override = {}) => createRecipeProjectRuntime({ name: "recipe-test", description: "test", directory, packageDirectory, agent: chosen, ...override });
  const drivers = [];
  const create = (override) => { const driver = make(override); drivers.push(driver); return driver; };
  t.after(async () => { for (const driver of drivers) await driver.close().catch(() => undefined); await runner.close(); await rm(base, { recursive: true, force: true }); });
  return { base, directory, runner, create, packageDirectory };
}
const portOf = (directory, id) => JSON.parse(readFileSync(join(directory, id, ".zelavis", "recipe-state.json"), "utf8")).ports.web;
const reachable = (port) => Effect.runPromise(loopbackPortAccepts(port));

test("a recipe Project installs once, runs, reports its address, stops and is removed", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t);
  const driver = create();
  const project = record("site1");
  await driver.prepare(project, project.recipe);
  const root = join(directory, "site1", "app");
  assert.equal(readFileSync(join(root, "installs.log"), "utf8"), "install\n");
  assert.ok((await driver.logs("site1")).some((entry) => /writing the server/.test(entry.message)), "install progress is in the Project's log");

  const started = await driver.start(project);
  const port = portOf(directory, "site1");
  assert.deepEqual([started.status, started.url], ["running", `http://127.0.0.1:${port}`]);
  assert.equal(await reachable(port), true);
  assert.equal((await driver.status("site1")).status, "running");
  assert.equal((await driver.start(project)).status, "running", "starting a running Project starts nothing twice");

  await driver.stop("site1");
  assert.equal((await driver.status("site1")).status, "stopped");
  assert.equal(await reachable(port), false);
  assert.equal(readFileSync(join(root, "stopped.log"), "utf8"), "stopped\n", "the recipe's stop phase ran");

  await driver.prepare(project, project.recipe);
  assert.equal(readFileSync(join(root, "installs.log"), "utf8"), "install\n", "a second prepare installs nothing");
  assert.equal((await driver.start(project)).url, started.url);
  await driver.stop("site1");

  await driver.destroy("site1");
  assert.equal(existsSync(join(directory, "site1")), false);
});

test("a change of software or method is a new install, not a silent reuse", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t);
  const driver = create();
  const project = record("site2");
  await driver.prepare(project, project.recipe);
  const state = () => JSON.parse(readFileSync(join(directory, "site2", ".zelavis", "recipe-state.json"), "utf8"));
  assert.equal(state().installed, true);
  const other = record("site2", { install: { method: "native", driver: "js", requires: ["node"], software: "9.9" } });
  await assert.rejects(driver.prepare(other, other.recipe), /does not offer software 9\.9/);
  assert.equal(state().software, "1.0", "a refused change leaves the record alone");
});

test("a start that is interrupted stops the processes it already started", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t, { startupDelayMs: 4000 });
  const driver = create();
  const project = record("site3");
  await driver.prepare(project, project.recipe);
  const fiber = Effect.runFork(effectOperations(driver).start(project));
  const port = portOf(directory, "site3");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await reachable(port), false, "nothing is left listening");
  assert.equal((await driver.status("site3")).status, "stopped");
});

test("a stop the Agent refused stays visible and can be retried, and keeps the Project's processes tracked", { timeout: 120_000 }, async (t) => {
  let refuse = true;
  const { create, directory } = await setup(t, { agent: (runner) => ({ ...runner, start: async (command, options) => {
    const child = await runner.start(command, options);
    return { ...child, get running() { return child.running; }, stop: async (stopOptions) => { if (refuse) throw new Error("Agent refused stop"); return child.stop(stopOptions); } };
  } }) });
  const driver = create();
  const project = record("site4");
  await driver.prepare(project, project.recipe);
  await driver.start(project);
  const port = portOf(directory, "site4");
  await assert.rejects(driver.stop("site4"), /could not be stopped/);
  assert.equal(await reachable(port), true, "it is still running, and the failure says so");
  refuse = false;
  await driver.stop("site4");
  assert.equal(await reachable(port), false);
});

test("a Platform that restarts adopts the processes its Agent kept running, and starts nothing twice", { timeout: 120_000 }, async (t) => {
  // An Agent that outlives the Platform: it keeps what it started and hands it back on request.
  const kept = new Map();
  const { create, directory } = await setup(t, { agent: (runner) => ({
    ...runner, survivesControlPlaneRestart: true,
    start: async (command, options) => {
      let listener = options?.onOutput;
      const child = await runner.start(command, { ...options, onOutput: (line) => listener?.(line) });
      const adoptable = Object.assign(child, { listen: (handler) => { listener = handler; } });
      kept.set(command.workloadId, [...(kept.get(command.workloadId) ?? []), { process: adoptable, command: { workloadId: command.workloadId, executable: command.executable, args: command.args, cwd: command.cwd }, replay: [] }]);
      return adoptable;
    },
    attach: async (id) => kept.get(id) ?? [],
  }) });
  const first = create();
  const project = record("site5");
  await first.prepare(project, project.recipe);
  await first.start(project);
  const port = portOf(directory, "site5");
  const installs = readFileSync(join(directory, "site5", "app", "installs.log"), "utf8");

  const second = create();
  assert.equal((await second.status("site5")).status, "stopped", "a new Platform knows nothing yet");
  await second.adopt();
  assert.equal((await second.status("site5")).status, "running");
  assert.equal(await reachable(port), true);
  assert.equal(readFileSync(join(directory, "site5", "app", "installs.log"), "utf8"), installs, "adoption installs nothing");
  assert.equal((await second.start(project)).status, "running", "starting an adopted Project does not start a second copy");
  await second.stop("site5");
  assert.equal(await reachable(port), false, "the adopted processes are the ones it stops");
});

test("a recipe whose package declares no install manifest, or a lock with none, is refused", { timeout: 60_000 }, async (t) => {
  const { create, base } = await setup(t);
  const empty = join(base, "empty-package");
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, "package.json"), JSON.stringify({ name: "@acme/x", version: "1.0.0", zelavis: { kind: "app" } }));
  const driver = create({ packageDirectory: empty });
  const project = record("site6");
  await assert.rejects(driver.prepare(project, project.recipe), /declares no zelavis\.project\.install/);
  const noLock = record("site7");
  delete noLock.recipe.install;
  await assert.rejects(create().prepare(noLock, noLock.recipe), /has no install lock/);
});

test("an unknown requirement is reported by name, not guessed at", { timeout: 60_000 }, async (t) => {
  const { create, base } = await setup(t);
  const packageDirectory = join(base, "odd-package");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@acme/odd", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"], install: { ...MANIFEST, methods: [{ ...MANIFEST.methods[0], requires: ["gpu-cluster"] }] } } } }));
  await writeFile(join(packageDirectory, "recipe.mjs"), RECIPE(0));
  const project = record("site8", { install: { method: "native", driver: "js", requires: ["gpu-cluster"], software: "1.0" } });
  await assert.rejects(create({ packageDirectory }).prepare(project, project.recipe), /does not know the requirement "gpu-cluster"/);
});
