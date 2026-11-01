// Recipe contract 2: app/ holds the application alone (its named directories), and everything the Platform
// runs it with lives in .zelavis/server. A contract 1 Project moves there by an ordinary live upgrade: the
// application's files are not touched, and what contract 1 kept beside them is set aside.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { materializeRecipeArtifact, digestArtifactDirectory } from "../dist/adapters/_recipe-artifact.js";

const manifest = (contract) => ({
  contract,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
  directories: [{ name: "site", path: "site" }],
});

/** Serves the configuration it was started with and the application's own page. */
const SERVER = `
const fs = require("node:fs"), http = require("node:http");
const [port, configFile, page] = process.argv.slice(2);
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ config: fs.readFileSync(configFile, "utf8"), page: fs.readFileSync(page, "utf8") }))).listen(Number(port), "127.0.0.1");
setInterval(() => {}, 1000);
`;

// Contract 1 writes everything relative to its root, app/; contract 2 writes its plumbing relative to its
// root, .zelavis/server, and the application by the absolute path of its named directory.
const recipeSource = (contract, message) => `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    const site = ${contract === 2 ? "context.directories.named.site" : '"site"'};
    yield* host.files.write("web.conf", ${JSON.stringify(message)});
    yield* host.files.write("server.js", ${JSON.stringify(SERVER)});
    if (!(yield* host.files.exists(site + "/index.html"))) yield* host.files.write(site + "/index.html", "the application's own page");
  }),
  start: (context) => Effect.succeed({ processes: [
    { name: "web", command: "node", args: [context.directories.root + "/server.js", String(context.ports.web), context.directories.root + "/web.conf", context.directories.named.site + "/index.html"],
      env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 4000 }, config: [context.directories.root + "/web.conf"] },
  ] }),
});
`;

async function packageFor(base, version, contract, message) {
  const directory = join(base, `recipe-${version.replaceAll(".", "-")}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@acme/layout", version, zelavis: { kind: "app", project: { runtimeKinds: ["native"], install: manifest(contract) } } }));
  await writeFile(join(directory, "dist", "recipe.mjs"), recipeSource(contract, message));
  return directory;
}

async function setup(t, first, { strict, starts } = {}) {
  const base = await mkdtemp(join(tmpdir(), "zv-contract2-"));
  const directory = join(base, "projects");
  const local = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  // Like the separately supervised Agent, which refuses a Project process that names no placement.
  const runner = strict || starts
    ? { ...local, start: (command, options) => {
        starts?.push({ executable: command.executable, cwd: command.cwd });
        return strict?.enforced && !command.placement
          ? Promise.reject(new Error("Project placement authority is required.")) : local.start(command, options);
      } }
    : local;
  const sources = {
    "1.0.0": await packageFor(base, "1.0.0", 1, "contract 1 configuration"),
    "2.0.0": await packageFor(base, "2.0.0", 2, "contract 2 configuration"),
  };
  const id = "layout";
  const project = join(directory, id);
  const data = join(project, ".zelavis");
  await mkdir(data, { recursive: true });
  const { digest } = await materializeRecipeArtifact(sources[first], data);
  const lock = (version, artifact) => ({ name: "@acme/layout", title: "Layout", version, specifier: "@acme/layout", runtimeKinds: ["native"],
    install: { method: "native", driver: "js", requires: ["node"], software: "1.0" }, ...(artifact ? { artifact: { digest: artifact } } : {}) });
  const record = { id, name: id, kind: "layout", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "running" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recipe: lock(first, digest) };
  const driver = createRecipeProjectRuntime({
    name: "recipe-test", description: "test", directory, packageDirectory: join(data, "recipe", "package"), agent: runner,
    recipes: {
      source: async (name, version) => name === "@acme/layout" ? sources[version] : undefined,
      stage: (source, dataDirectory) => materializeRecipeArtifact(source, dataDirectory),
      digest: (path) => digestArtifactDirectory(path),
    },
  });
  t.after(async () => { await driver.close().catch(() => undefined); await local.close(); await rm(base, { recursive: true, force: true }); });
  await driver.prepare(record, record.recipe);
  await driver.start(record);
  const state = JSON.parse(readFileSync(join(data, "recipe-state.json"), "utf8"));
  const ask = async () => (await fetch(`http://127.0.0.1:${state.ports.web}/`)).json();
  return { project, data, driver, record, lock, ask, id };
}

test("a contract 2 Project keeps the application alone in app/ and its server files in .zelavis/server", async (t) => {
  const { project, ask } = await setup(t, "2.0.0");
  assert.deepEqual(await readdir(join(project, "app")), ["site"], "nothing but the application's named directory");
  assert.deepEqual((await readdir(join(project, ".zelavis", "server"))).sort(), ["server.js", "web.conf"]);
  assert.deepEqual(await ask(), { config: "contract 2 configuration", page: "the application's own page" });
});

test("a running contract 1 Project upgrades live to a contract 2 recipe without touching the application", async (t) => {
  const { project, driver, record, lock, ask, id } = await setup(t, "1.0.0");
  assert.deepEqual((await readdir(join(project, "app"))).sort(), ["server.js", "site", "web.conf"], "contract 1 keeps both together");
  assert.deepEqual(await ask(), { config: "contract 1 configuration", page: "the application's own page" });
  const page = join(project, "app", "site", "index.html");
  const before = statSync(page);

  const execution = await driver.prepareUpdate(record, { ...record, recipe: lock("2.0.0") });
  await driver.applyUpdate(id, execution, async () => undefined);

  assert.deepEqual(await ask(), { config: "contract 2 configuration", page: "the application's own page" }, "now served from the new root");
  const after = statSync(page);
  assert.equal(after.ino, before.ino, "the application's file is the same file");
  assert.equal(after.mtimeMs, before.mtimeMs, "and was not written");
  assert.deepEqual(await readdir(join(project, "app")), ["site"], "app/ holds the application alone");
  assert.deepEqual((await readdir(join(project, ".zelavis", "server", "contract-1"))).sort(), ["server.js", "web.conf"], "contract 1's files are set aside, not deleted");
});

test("processes adopted without a placement are replaced under the placement the update carries", async (t) => {
  // Started as an adopted Project's are known after a Platform update: by a controller that holds no placement.
  const strict = { enforced: false };
  const { project, driver, record, lock, ask, id } = await setup(t, "1.0.0", { strict });
  strict.enforced = true;
  const placement = { projectId: id, nodeId: "local", ownerSession: "owner", epoch: 1 };
  const execution = await driver.prepareUpdate(record, { ...record, recipe: lock("2.0.0") }, placement);
  await driver.applyUpdate(id, execution, async () => undefined);
  assert.deepEqual(await ask(), { config: "contract 2 configuration", page: "the application's own page" });
  assert.deepEqual(await readdir(join(project, "app")), ["site"]);
});

test("an update that failed for want of a placement is recovered under the placement the Platform holds", async (t) => {
  const strict = { enforced: false };
  const { driver, record, lock, ask, id } = await setup(t, "1.0.0", { strict });
  strict.enforced = true;
  // What an earlier release did after Update now: no placement reached the replacement, and the rollback
  // was refused the same way, leaving the update journaled and the previous processes not all running.
  const execution = await driver.prepareUpdate(record, { ...record, recipe: lock("2.0.0") });
  await assert.rejects(driver.applyUpdate(id, execution, async () => undefined), /could not be started/);
  const placement = { projectId: id, nodeId: "local", ownerSession: "owner", epoch: 1 };
  assert.equal(await driver.recoverUpdate(id, execution, placement), "previous");
  assert.deepEqual(await ask(), { config: "contract 1 configuration", page: "the application's own page" }, "the previous recipe serves again");
});

test("processes a live upgrade to the new layout starts run from the new root, where a later adoption looks for them", async (t) => {
  const starts = [];
  const { project, driver, record, lock, id } = await setup(t, "1.0.0", { starts });
  assert.deepEqual(starts.map((start) => start.cwd), [join(project, "app")], "contract 1 runs from app/");
  starts.length = 0;
  const execution = await driver.prepareUpdate(record, { ...record, recipe: lock("2.0.0") });
  await driver.applyUpdate(id, execution, async () => undefined);
  assert.ok(starts.length > 0, "the upgrade replaced the process");
  assert.deepEqual([...new Set(starts.map((start) => start.cwd))], [join(project, ".zelavis", "server")]);
});
