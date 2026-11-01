// Upgrading a running Project to a newer recipe, through the driver: the processes keep serving,
// only what changed changes, and anything that goes wrong puts everything back.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { materializeRecipeArtifact, digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";

const MANIFEST = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }, { name: "db", protocol: "tcp" }],
};

/** A recipe whose web process reloads on SIGHUP when web.conf changes, and whose database restarts. */
const recipeSource = ({ message, dbArgs = "", failInstall = false, neverReady = false }) => `import { Effect } from "effect";
import { RecipeError, RecipeHost, defineRecipe } from "zelavis/recipe";
const SERVER = ${JSON.stringify(`
const fs = require("node:fs"), http = require("node:http");
const [name, port, configFile, flag] = process.argv.slice(2);
const read = () => { try { return fs.readFileSync(configFile, "utf8"); } catch { return "none"; } };
let current = read();
process.on("SIGHUP", () => { current = read(); });
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ name, pid: process.pid, config: current, flag }))).listen(Number(port), "127.0.0.1");
setInterval(() => {}, 1000);
`)};
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    ${failInstall ? 'return yield* Effect.fail(new RecipeError({ operation: "install", message: "The new configuration is not valid." }));' : ""}
    yield* host.files.write("web.conf", ${JSON.stringify(message)});
    yield* host.files.write("server.js", SERVER);
  }),
  start: (context) => Effect.succeed({ processes: [
    { name: "db", command: "node", args: [context.directories.root + "/server.js", "db", String(context.ports.db), "-", "${dbArgs}"], env: {}, dependsOn: [],
      readiness: { port: "db", timeoutMs: 4000 } },
    { name: "web", command: "node", args: [context.directories.root + "/server.js", "web", String(context.ports.web), context.directories.root + "/web.conf", "x"], env: {}, dependsOn: ["db"],
      readiness: { port: ${neverReady ? '"web"' : '"web"'}, timeoutMs: 4000 },
      config: [context.directories.root + "/web.conf"], update: { strategy: "reload", signal: "SIGHUP" } },
  ] }),
});
`;

async function packageFor(base, name, version, options) {
  const directory = join(base, `recipe-${name}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@acme/live", version, zelavis: { kind: "app", project: { runtimeKinds: ["native"], install: MANIFEST } } }));
  await writeFile(join(directory, "dist", "recipe.mjs"), recipeSource(options));
  return directory;
}

async function setup(t, versions) {
  const base = await mkdtemp(join(tmpdir(), "zv-live-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const sources = {};
  for (const [version, options] of Object.entries(versions)) sources[version] = await packageFor(base, version.replaceAll(".", "-"), version, options);
  const id = "live1";
  const data = join(directory, id, ".zelavis");
  await mkdir(data, { recursive: true });
  const { digest } = await materializeRecipeArtifact(sources["1.0.0"], data);
  const lock = (version, artifact) => ({ name: "@acme/live", title: "Live", version, specifier: "@acme/live", runtimeKinds: ["native"], install: { method: "native", driver: "js", requires: ["node"], software: "1.0" }, ...(artifact ? { artifact: { digest: artifact } } : {}) });
  const project = { id, name: id, kind: "live", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "running" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recipe: lock("1.0.0", digest) };
  const driver = createRecipeProjectRuntime({
    name: "recipe-test", description: "test", directory, packageDirectory: join(data, "recipe", "package"), agent: runner,
    recipes: {
      source: async (name, version) => name === "@acme/live" ? sources[version] : undefined,
      stage: (source, dataDirectory) => materializeRecipeArtifact(source, dataDirectory),
      digest: (directory) => digestArtifactDirectory(directory),
    },
  });
  t.after(async () => { await driver.close().catch(() => undefined); await runner.close(); await rm(base, { recursive: true, force: true }); });
  await driver.prepare(project, project.recipe);
  await driver.start(project);
  const state = JSON.parse(readFileSync(join(directory, id, ".zelavis", "recipe-state.json"), "utf8"));
  const ask = async (name) => (await fetch(`http://127.0.0.1:${state.ports[name]}/`)).json();
  const candidate = (version) => ({ ...project, recipe: lock(version) });
  const upgrade = async (version, commit = async () => undefined) => {
    const execution = await driver.prepareUpdate(project, candidate(version));
    return { execution, snapshot: await driver.applyUpdate(id, execution, commit) };
  };
  return { base, directory, data, driver, project, state, ask, upgrade, candidate, sources, lock, runner };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frozenVersion = async (data) => JSON.parse(await readFile(join(data, "recipe", "package", "package.json"), "utf8")).version;

test("a running Project is upgraded to a newer recipe with no failed request: the web tier reloads, the database is not touched", { timeout: 120_000 }, async (t) => {
  const { driver, data, ask, upgrade, directory, project } = await setup(t, { "1.0.0": { message: "from version one" }, "2.0.0": { message: "from version two" } });
  const before = { web: await ask("web"), db: await ask("db") };
  assert.equal(before.web.config, "from version one");

  let stop = false; let failures = 0; let served = 0; const bodies = new Set();
  const traffic = (async () => { while (!stop) { try { const body = await ask("web"); bodies.add(body.config); served += 1; } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  const chosen = [];
  const { execution } = await upgrade("2.0.0", async (choice) => { chosen.push(choice); });
  await sleep(100);
  stop = true; await traffic;

  assert.equal(failures, 0, "not one request failed while the Project changed recipe");
  assert.ok(served > 30);
  assert.deepEqual([...bodies].sort(), ["from version one", "from version two"]);
  const after = { web: await ask("web"), db: await ask("db") };
  assert.equal(after.web.pid, before.web.pid, "the same web process, reloaded");
  assert.equal(after.db.pid, before.db.pid, "the database was never touched");
  assert.equal(after.web.config, "from version two");
  assert.deepEqual(chosen, ["target"]);
  assert.equal(await frozenVersion(data), "2.0.0", "the Project's frozen recipe is now the new one");
  const descriptor = JSON.parse(readFileSync(join(directory, project.id, "project.json"), "utf8"));
  assert.deepEqual([descriptor.recipe.version, descriptor.recipe.artifact.digest], ["2.0.0", execution.target.digest]);
  assert.equal(await digestArtifactDirectory(join(data, "recipe", "package")), execution.target.digest, "and it matches the digest the Platform will record");
  assert.equal(existsSync(join(data, "upgrade")), false, "no workspace left behind");
  assert.deepEqual([execution.mode, execution.previous.version, execution.target.version], ["recipe", "1.0.0", "2.0.0"]);
  assert.equal((await driver.status(project.id)).status, "running");
});

test("only what changed is replaced: a different database launch restarts the database and leaves the web tier running", { timeout: 120_000 }, async (t) => {
  const { ask, upgrade } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "one", dbArgs: "tuned" } });
  const before = { web: await ask("web"), db: await ask("db") };
  await upgrade("2.0.0");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.notEqual(after.db.pid, before.db.pid, "the database was replaced");
  assert.equal(after.db.flag, "tuned");
  assert.equal(after.web.pid, before.web.pid, "the web process was not restarted");
});

test("an upgrade whose recipe changes nothing the processes read restarts nothing and reloads nothing", { timeout: 120_000 }, async (t) => {
  const { ask, upgrade, data } = await setup(t, { "1.0.0": { message: "same" }, "2.0.0": { message: "same" } });
  const before = { web: await ask("web"), db: await ask("db") };
  await upgrade("2.0.0");
  assert.deepEqual([(await ask("web")).pid, (await ask("db")).pid], [before.web.pid, before.db.pid]);
  assert.equal(await frozenVersion(data), "2.0.0");
});

test("when the new recipe's install fails, nothing changed: same processes, same configuration, the previous recipe", { timeout: 120_000 }, async (t) => {
  const { driver, ask, upgrade, data, directory, project } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two", failInstall: true } });
  const before = { web: await ask("web"), db: await ask("db") };
  await assert.rejects(upgrade("2.0.0"), /The new configuration is not valid/);
  assert.deepEqual([(await ask("web")).pid, (await ask("db")).pid], [before.web.pid, before.db.pid]);
  assert.equal((await ask("web")).config, "one");
  assert.equal(readFileSync(join(directory, project.id, "app", "web.conf"), "utf8"), "one");
  assert.equal(await frozenVersion(data), "1.0.0");
  // The Platform then asks the driver to recover; there is nothing to undo, and it says so.
  assert.equal(await driver.recoverUpdate(project.id, {}), "previous");
  assert.equal(existsSync(join(data, "upgrade")), false);
});

test("when a process of the new plan never becomes ready, the configuration is restored and the Project is back on its previous plan", { timeout: 120_000 }, async (t) => {
  // v2's database is sabotaged below so that it cannot start.
  const { driver, ask, upgrade, data, directory, project } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two", dbArgs: "broken" } });
  // Break v2's database readiness by making its server never listen on the declared port.
  const broken = join(data, "..", "..", "..", "recipe-2-0-0", "dist", "recipe.mjs");
  const text = await readFile(broken, "utf8");
  await writeFile(broken, text.replace('"db", String(context.ports.db)', '"db", "1"'));
  const before = { web: await ask("web"), db: await ask("db") };
  await assert.rejects(upgrade("2.0.0"), /"db" exited before it was ready/);
  // The failed upgrade left a journal for the Platform to recover, and recovery settles it.
  assert.equal(await driver.recoverUpdate(project.id, {}), "previous");
  const after = { web: await ask("web"), db: await ask("db") };
  assert.equal(after.db.flag, "", "the database is the previous plan's again");
  assert.equal(after.web.config, "one", "and the web tier reads the previous configuration");
  assert.equal(readFileSync(join(directory, project.id, "app", "web.conf"), "utf8"), "one");
  assert.equal(await frozenVersion(data), "1.0.0");
  assert.notEqual(after.db.pid, before.db.pid, "the database had to be replaced and was put back");
  assert.equal(after.web.pid, before.web.pid, "the web tier was never replaced");
});

test("when the Platform cannot record the upgrade, the new recipe is taken back out and the processes return to the previous plan", { timeout: 120_000 }, async (t) => {
  const { driver, ask, upgrade, data, directory, project } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two" } });
  const before = await ask("web");
  await assert.rejects(upgrade("2.0.0", async () => { throw new Error("the store is unavailable"); }), /the store is unavailable/);
  assert.equal(await frozenVersion(data), "1.0.0", "the frozen recipe is the previous one again");
  const descriptor = JSON.parse(readFileSync(join(directory, project.id, "project.json"), "utf8"));
  assert.equal(descriptor.recipe.version, "1.0.0");
  assert.equal((await ask("web")).config, "one");
  assert.equal((await ask("web")).pid, before.pid);
  assert.equal(await driver.recoverUpdate(project.id, {}), "previous");
});

test("recovery after a crash decides by the one physical fact: whether the new recipe was switched in", { timeout: 120_000 }, async (t) => {
  const { driver, ask, data, project, candidate } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two" } });
  // Staged only: previous.
  await driver.prepareUpdate(project, candidate("2.0.0"));
  assert.equal(existsSync(join(data, "upgrade", "journal.json")), true);
  assert.equal(await driver.recoverUpdate(project.id, {}), "previous");
  assert.equal(existsSync(join(data, "upgrade")), false);
  assert.equal((await ask("web")).config, "one");

  // Switched (as if the process died between recording the switch and clearing the workspace): target.
  const execution = await driver.prepareUpdate(project, candidate("2.0.0"));
  const journalFile = join(data, "upgrade", "journal.json");
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  await writeFile(journalFile, JSON.stringify({ ...journal, state: "switched" }));
  assert.equal(await driver.recoverUpdate(project.id, execution), "target");
  assert.equal(existsSync(join(data, "upgrade")), false);
});

test("a second upgrade cannot be started while one is unfinished", { timeout: 120_000 }, async (t) => {
  const { driver, project, candidate } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two" } });
  await driver.prepareUpdate(project, candidate("2.0.0"));
  await assert.rejects(driver.prepareUpdate(project, candidate("2.0.0")), /unfinished; it must be recovered first/);
  await driver.recoverUpdate(project.id, {});
});

test("a recipe that no longer offers the Project's method, or a version this host does not have, is refused before anything changes", { timeout: 120_000 }, async (t) => {
  const { driver, project, candidate, ask, data } = await setup(t, { "1.0.0": { message: "one" } });
  await assert.rejects(driver.prepareUpdate(project, candidate("9.9.9")), /not available on this host/);
  assert.equal((await ask("web")).config, "one");
  assert.equal(existsSync(join(data, "upgrade")), false);
});

test("a Project that is not running from a saved plan cannot be upgraded in place", { timeout: 120_000 }, async (t) => {
  const { driver, project, upgrade } = await setup(t, { "1.0.0": { message: "one" }, "2.0.0": { message: "two" } });
  await driver.stop(project.id);
  await assert.rejects(upgrade("2.0.0"), /not running from a saved plan/);
  await driver.recoverUpdate(project.id, {});
});
