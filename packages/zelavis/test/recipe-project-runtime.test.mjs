// The generic recipe runtime with a small recipe that needs only Node: lifecycle, install-once,
// stop and interruption behaviour, adoption after a restart, and refusal of the unsupported.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

const ADOPT = {
  state: "legacy-state.json", move: { "legacy-data": "data" }, ports: { web: "port" }, socketId: "socket",
  marks: ["data/.adopted"], discard: ["legacy-generated.conf"],
};

async function recipePackage(base, startupDelayMs = 0, { adopt = false, failInstall = false } = {}) {
  const packageDirectory = join(base, "recipe-package");
  await mkdir(packageDirectory, { recursive: true });
  const install = adopt ? { ...MANIFEST, adopt: [ADOPT] } : MANIFEST;
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "@acme/node-site", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"], install } } }));
  const source = RECIPE(startupDelayMs);
  await writeFile(join(packageDirectory, "recipe.mjs"), failInstall
    ? source.replace("yield* host.progress({ phase: \"install\", message: \"writing the server\" });", "return yield* Effect.fail(new RecipeError({ operation: \"install\", message: \"The configuration is not valid.\" }));").replace('import { RecipeHost, defineRecipe }', 'import { RecipeError, RecipeHost, defineRecipe }')
    : source);
  return packageDirectory;
}

const record = (id, over = {}) => ({
  id, name: id, kind: "node-site", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  recipe: { name: "@acme/node-site", title: "Site", version: "1.0.0", specifier: "@acme/node-site", runtimeKinds: ["native"], install: { method: "native", driver: "js", requires: ["node"], software: "1.0" }, ...over },
});

async function setup(t, { startupDelayMs = 0, agent, recipe } = {}) {
  const base = await mkdtemp(join(tmpdir(), "zv-recipe-runtime-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const chosen = agent?.(runner) ?? runner;
  const packageDirectory = await recipePackage(base, startupDelayMs, recipe);
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

/** What an earlier layout of this recipe left: its state, a data folder, and a generated file. */
async function legacyProject(directory, id, port = 24680) {
  const zelavis = join(directory, id, ".zelavis");
  await mkdir(join(zelavis, "legacy-data", "sub"), { recursive: true });
  await writeFile(join(zelavis, "legacy-data", "note.txt"), "the application's own data");
  await writeFile(join(zelavis, "legacy-data", "sub", "more.bin"), "more");
  await writeFile(join(zelavis, "legacy-generated.conf"), "regenerated by the new recipe");
  await writeFile(join(zelavis, "legacy-state.json"), JSON.stringify({ port, socket: "oldsocket1" }));
  return zelavis;
}
const tree = (directory) => {
  const out = {};
  const walk = (path, prefix) => { for (const name of readdirSync(path).sort()) { const full = join(path, name); if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`); else out[`${prefix}${name}`] = readFileSync(full, "utf8"); } };
  walk(directory, "");
  return out;
};

test("a Project of an earlier layout is taken over: its data is moved, its address kept, the new recipe installs over it", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t, { recipe: { adopt: true } });
  const zelavis = await legacyProject(directory, "old1");
  const driver = create();
  const project = record("old1");
  await driver.prepare(project, project.recipe);

  const root = join(directory, "old1", "app");
  assert.equal(readFileSync(join(root, "data", "note.txt"), "utf8"), "the application's own data");
  assert.equal(readFileSync(join(root, "data", "sub", "more.bin"), "utf8"), "more");
  assert.equal(existsSync(join(zelavis, "legacy-data")), false, "moved, not copied");
  const state = JSON.parse(readFileSync(join(zelavis, "recipe-state.json"), "utf8"));
  assert.equal(state.ports.web, 24680, "the address the Project already had");
  assert.equal(state.socketId, "oldsocket1");
  assert.equal(state.installed, true);
  assert.equal(readFileSync(join(root, "installs.log"), "utf8"), "install\n", "the recipe's own install ran over what was there");
  assert.ok(existsSync(join(root, "data", ".adopted")));
  assert.ok(existsSync(join(zelavis, "legacy-state.json")), "the way back stays open until the new layout is in use");

  const started = await driver.start(project);
  assert.equal(started.url, "http://127.0.0.1:24680");
  assert.equal(await reachable(24680), true);
  assert.equal(existsSync(join(zelavis, "legacy-state.json")), false, "running on the new layout closes the way back");
  assert.equal(existsSync(join(zelavis, "legacy-generated.conf")), false);
  assert.equal(existsSync(join(zelavis, "adoption.json")), false);
  assert.equal(readFileSync(join(root, "data", "note.txt"), "utf8"), "the application's own data");
  await driver.stop("old1");
});

test("an upgrade that is not recorded is abandoned and the earlier layout is exactly as it was", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t, { recipe: { adopt: true } });
  const zelavis = await legacyProject(directory, "old2");
  const before = tree(join(directory, "old2"));
  const driver = create();
  const project = record("old2");
  await driver.prepare(project, project.recipe);
  assert.ok(existsSync(join(directory, "old2", "app")));
  await driver.abandonUpgrade("old2");
  // The Project's descriptor is the Platform's to restore (it prepares the earlier recipe again).
  await rm(join(directory, "old2", "project.json"));
  assert.deepEqual(tree(join(directory, "old2")), before, "every earlier file is back, byte for byte");
  assert.equal(existsSync(join(directory, "old2", "app")), false);
  assert.equal(existsSync(join(zelavis, "recipe-state.json")), false);
  assert.equal(existsSync(join(zelavis, "adoption.json")), false);

  // And it can be tried again.
  await driver.prepare(project, project.recipe);
  await driver.commitUpgrade("old2");
  assert.equal(existsSync(join(zelavis, "legacy-state.json")), false);
});

test("an install that fails after the move puts the data back before it reports", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t, { recipe: { adopt: true, failInstall: true } });
  await legacyProject(directory, "old3");
  const before = tree(join(directory, "old3"));
  const driver = create();
  const project = record("old3");
  await assert.rejects(driver.prepare(project, project.recipe), /The configuration is not valid/);
  assert.deepEqual(tree(join(directory, "old3")), before, "the Project is as it was, and can still be run by the recipe that made it");
});

test("a recipe that does not describe an earlier layout leaves it alone and installs fresh", { timeout: 120_000 }, async (t) => {
  const { create, directory } = await setup(t);
  const zelavis = await legacyProject(directory, "old4");
  const driver = create();
  const project = record("old4");
  await driver.prepare(project, project.recipe);
  assert.equal(existsSync(join(zelavis, "legacy-data")), true, "nothing was taken");
  assert.equal(JSON.parse(readFileSync(join(zelavis, "recipe-state.json"), "utf8")).ports.web === 24680, false);
});
