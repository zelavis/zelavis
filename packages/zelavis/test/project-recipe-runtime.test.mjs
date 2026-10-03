import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-recipe-rt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A recipe package that provides its own runtime, recording what it is asked to do. */
async function recipePackage(root, { marker = "v1", runtime = "./dist/runtime.js", exportsFactory = true } = {}) {
  const directory = join(root, "pkg");
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/site", version: "1.0.0", type: "module",
    exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", project: { runtimeKinds: ["native"], runtime } },
  }));
  await writeFile(join(directory, "dist", "index.js"), "export function register() {}");
  await writeFile(join(directory, "dist", "runtime.js"), exportsFactory ? `
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
export const MARKER = ${JSON.stringify(marker)};
export function createProjectRuntime({ directory, options }) {
  const running = new Set();
  return {
    name: "acme-runtime-" + MARKER,
    runtimeKinds: ["native"], defaultRuntimeKind: "native", startupConcurrency: 1,
    capabilities: () => ({ description: "acme " + MARKER + " " + (options.flavour ?? "plain") }),
    async prepare(project, recipe) {
      await mkdir(join(directory, project.id), { recursive: true });
      await writeFile(join(directory, project.id, "project.json"), JSON.stringify({ ...project, recipe }));
      await writeFile(join(directory, project.id, "prepared-by.txt"), MARKER + ":" + (recipe.artifact?.digest ?? "none"));
    },
    async start(project) { running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { running.delete(id); return { status: "stopped" }; },
    async status(id) { return running.has(id) ? { status: "running" } : { status: "stopped" }; },
    async logs() { return []; },
    async destroy(id) { running.delete(id); },
    async close() {},
  };
}
` : "export const nothing = 1;");
  return directory;
}

const project = (id = "site") => ({
  id, name: id, kind: "acme-site", runtimeKind: "native",
  recipe: { name: "@acme/site", title: "Site", version: "1.0.0", specifier: "@acme/site", runtimeKinds: ["native"] },
});

function router(directory, source, { trusted = true, options } = {}) {
  return createLocalProjectRuntime({
    directory,
    recipeRuntimes: { packageDirectory: (name) => (name === "@acme/site" ? source : undefined), trusted: () => trusted },
    ...(options ? { recipeRuntimeOptions: options } : {}),
  });
}

test("a recipe that ships its runtime is frozen into the Project and run from the frozen copy", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root, { marker: "v1" });
  const projects = join(root, "projects");
  const driver = router(projects, source, { options: { "@acme/site": { flavour: "spicy" } } });
  t.after(() => driver.close());

  const p = project();
  await driver.prepare(p, p.recipe);
  const frozen = join(projects, "site", ".zelavis", "recipe", "package");
  await access(join(frozen, "dist", "runtime.js"));
  const prepared = await readFile(join(projects, "site", "prepared-by.txt"), "utf8");
  assert.match(prepared, /^v1:sha256:[0-9a-f]{64}$/, "the driver is given the frozen digest");
  assert.match(driver.capabilities(p).description, /acme v1 spicy/, "its own capabilities and its options");

  assert.equal((await driver.start(p)).status, "running");
  assert.equal((await driver.status("site")).status, "running");
  assert.equal((await driver.stop("site")).status, "stopped");

  // The Platform's copy changes; a restarted Platform still runs the frozen one.
  await recipePackage(root, { marker: "v2" });
  const restarted = router(projects, source);
  t.after(() => restarted.close());
  await restarted.adopt();
  await restarted.start(p);
  assert.match(restarted.capabilities(p).description, /acme v1/, "the frozen runtime, not the current package");
});

test("a recipe cannot provide a runtime the host has not enabled, and nothing is frozen", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root);
  const projects = join(root, "projects");
  const driver = router(projects, source, { trusted: false });
  t.after(() => driver.close());
  const p = project();
  await assert.rejects(driver.prepare(p, p.recipe), /has not enabled that/);
  await assert.rejects(access(join(projects, "site", ".zelavis")), { code: "ENOENT" });
});

test("a frozen runtime that no longer matches its digest is refused", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root);
  const projects = join(root, "projects");
  const first = router(projects, source);
  const p = project();
  await first.prepare(p, p.recipe);
  await first.close();

  await writeFile(join(projects, "site", ".zelavis", "recipe", "package", "dist", "runtime.js"), "export const evil = true;");
  const second = router(projects, source);
  t.after(() => second.close());
  await assert.rejects(second.start(p), /does not match its locked digest/);
});

test("a recipe's runtime must be a path inside its own package and must export the factory", async (t) => {
  const root = await scratch(t);
  const p = project();
  for (const runtime of ["../evil.js", "/etc/passwd", "dist/runtime.js", "./a/../../b.js"]) {
    const source = await recipePackage(join(root, runtime.replace(/\W/g, "_")), { runtime });
    const driver = router(join(root, `p-${runtime.replace(/\W/g, "_")}`), source);
    await assert.rejects(driver.prepare(p, p.recipe), /must be a path inside its own package/, runtime);
    await driver.close();
  }
  const source = await recipePackage(join(root, "nofactory"), { exportsFactory: false });
  const driver = router(join(root, "p-nofactory"), source);
  await assert.rejects(driver.prepare(p, p.recipe), /does not export createProjectRuntime/);
  await driver.close();
});

test("the official WordPress package loads from its frozen copy, through the Platform's own exports", async (t) => {
  const root = await scratch(t);
  const source = join(REPO, "zelavis-services", "wordpress");
  const projects = join(root, "projects");
  const driver = createLocalProjectRuntime({
    directory: projects,
    recipeRuntimes: { packageDirectory: (name) => (name === "@zelavis/wordpress" ? source : undefined), trusted: () => true },
  });
  t.after(() => driver.close());
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const p = {
    id: "blog", name: "blog", kind: "wordpress", runtimeKind: "native",
    recipe: { name: "@zelavis/wordpress", title: "WordPress", version: manifest.version, specifier: "@zelavis/wordpress", runtimeKinds: ["native"] },
  };

  // Provisioning needs nginx, PHP and MariaDB, which a test host is not asked
  // to install (a container check does that). Whatever it reports, it must be
  // WordPress's own runtime running from the frozen copy, not a refusal to load it.
  const outcome = await driver.prepare(p, p.recipe).then(() => "prepared", (error) => String(error.message));
  assert.doesNotMatch(outcome, /has not enabled|locked digest|does not export|Cannot find package|ERR_MODULE_NOT_FOUND/);
  await access(join(projects, "blog", ".zelavis", "recipe", "package", "dist", "runtime.js"));
  assert.match(driver.capabilities(p).description, /WordPress/);
});


test("an acquired runtime recipe is prepared by its own driver before start", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root);
  const projects = join(root, "projects");
  const requested = [];
  const driver = createLocalProjectRuntime({
    directory: projects,
    recipeRuntimes: { trusted: () => true },
    recipePackageDirectory: (name, version) => { requested.push([name, version]); return source; },
  });
  t.after(() => driver.close());
  const p = project();
  await driver.prepare(p, p.recipe);
  assert.deepEqual(requested, [["@acme/site", "1.0.0"]]);
  assert.match(await readFile(join(projects, "site", "prepared-by.txt"), "utf8"), /^v1:sha256:/);
  assert.equal((await driver.start(p)).status, "running");
});

test("a recipe source with another version cannot execute or be frozen", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root);
  const projects = join(root, "projects");
  const driver = createLocalProjectRuntime({ directory: projects, recipeRuntimes: { trusted: () => true }, recipePackageDirectory: () => source });
  t.after(() => driver.close());
  const p = project(); p.recipe.version = "2.0.0";
  await assert.rejects(driver.prepare(p, p.recipe), /does not match its locked name and version/);
  await assert.rejects(access(join(projects, "site", ".zelavis", "recipe")), { code: "ENOENT" });
});
