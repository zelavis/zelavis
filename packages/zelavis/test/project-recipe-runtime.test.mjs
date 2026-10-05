import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import { zelavis, createMemorySystemStore } from "../dist/index.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createProjectForwarder } from "../dist/platform/project-gateway.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-recipe-rt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A recipe package that provides its own runtime, recording what it is asked to do. */
async function recipePackage(root, { marker = "v1", version = "1.0.0", failPrepare = false, failDestroy = false, runtime = "./dist/runtime.js", exportsFactory = true, managed, backend = false } = {}) {
  const directory = join(root, "pkg");
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/site", version, type: "module",
    exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", namespace: "acmesite", project: { runtimeKinds: ["native"], runtime, ...(managed ? { managed } : {}) } },
  }));
  await writeFile(join(directory, "dist", "index.js"), managed ? `
import { zelavis } from "zelavis/sdk";
import { ZELAVIS_VERSION } from "zelavis";
import { Effect } from "effect";
export function register() {
  zelavis.plugins.ui.menus.create({ title: "Integration ${marker}", path: "/integration", surface: "root", page: { id: "integration", bundle: "dashboard", file: "index.html" } });
  zelavis.operations.create({ id: "revision.get", resource: "revision", action: "get", method: "GET", path: "/revision", spec: { operationId: "getRevision", summary: "Read integration revision" }, access: { permissions: ["site.read"], scope: { type: "project", projectId: "site" } },
    handler: () => ({ status: 200, body: { revision: ${JSON.stringify(marker)}, engine: ZELAVIS_VERSION } }) });
  zelavis.routes.create({ id: "revision.${marker}", method: "GET", path: "/${marker}", handler: () => ({ status: 200, body: { revision: ${JSON.stringify(marker)} } }) });
  zelavis.setup(context => {
    const tenant = ${backend ? 'context.core.database.forTenant("site")' : 'undefined'};
    context.addEndpointGroup({ id: "recipe.setup", context: {}, origin: { type: "service", serviceName: "@acme/site" }, basePath: "/setup", api: { v1: [{ id: "setup", method: "GET", path: "/", handler: () => ({ status: 200, body: { revision: ${JSON.stringify(marker)} } }) }] } });
    ${backend ? `context.addEndpointGroup({ id: "recipe.native", context: {}, origin: { type: "service", serviceName: "@acme/site" }, basePath: "/integration-native", api: { v1: [{ id: "native", method: "POST", path: "/:capability", access: { permissions: ["site.write"] }, handler: ({ params }) => Effect.runPromise(Effect.gen(function* () {
      const call = operation => Effect.tryPromise({ try: operation, catch: error => error });
      if (params.capability === "database") {
        const existing = yield* call(() => tenant.documents.listCollections());
        if (!existing.some(collection => collection.name === "power")) yield* call(() => tenant.documents.createCollection({ name: "power" }));
        yield* call(() => tenant.documents.insert({ collection: "power", id: "proof", data: { title: "private app data" } }));
      } else if (params.capability === "identity") yield* call(() => context.core.auth.accounts.create({ id: "integration-user", email: "user@example.test" }));
      else if (params.capability === "storage") yield* call(() => context.core.storage.put({ path: "integration-proof.txt", body: new TextEncoder().encode("private storage") }));
      else if (params.capability === "workloads") yield* call(() => context.core.workloads.store.save({ id: "integration-job", projectId: "site", type: "job", name: "integration job", code: "export default () => {}", enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      return { status: 200, body: { exercised: params.capability } };
    })) }] } });` : ""}
  });
}` : "export function register() {}");
  if (managed) { await mkdir(join(directory, "dashboard"), { recursive: true }); await writeFile(join(directory, "dashboard/index.html"), "<h1>Integration " + marker + "</h1>"); }
  await writeFile(join(directory, "dist", "runtime.js"), exportsFactory ? `
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
export const MARKER = ${JSON.stringify(marker)};
export function createProjectRuntime({ directory, options }) {
  const running = new Set();
  return {
    name: "acme-runtime-" + MARKER,
    runtimeKinds: ["native"], defaultRuntimeKind: "native", startupConcurrency: 1,
    capabilities: () => ({ description: "acme " + MARKER + " " + (options.flavour ?? "plain") }),
    async prepare(project, recipe) {
      if (${JSON.stringify(failPrepare)}) throw new Error("candidate preparation failed");
      await mkdir(join(directory, project.id), { recursive: true });
      await writeFile(join(directory, project.id, "project.json"), JSON.stringify({ ...project, recipe }));
      await writeFile(join(directory, project.id, "prepared-by.txt"), MARKER + ":" + (recipe.artifact?.digest ?? "none"));
    },
    async start(project) { await appendFile(join(directory, project.id, "workload-events"), "start:" + MARKER + "\\n"); running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { if (running.has(id)) await appendFile(join(directory, id, "workload-events"), "stop:" + MARKER + "\\n"); running.delete(id); return { status: "stopped" }; },
    async status(id) { return running.has(id) ? { status: "running", url: "http://127.0.0.1:1" } : { status: "stopped" }; },
    async logs() { return []; },
    async destroy(id) { if (${JSON.stringify(failDestroy)}) throw new Error("recipe cleanup failed"); running.delete(id); },
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

function router(directory, source, { trusted = true, options, agent } = {}) {
  return createLocalProjectRuntime({
    directory,
    ...(agent ? { agent } : {}),
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


test("a custom recipe upgrades its frozen code in the same process and after restart", async (t) => {
  const root=await scratch(t);
  const source=await recipePackage(root);
  const projects=join(root,"projects");
  const nest = async () => {
    await writeFile(join(source,"dist","driver.js"),await readFile(join(source,"dist","runtime.js")));
    await writeFile(join(source,"dist","runtime.js"),"export { createProjectRuntime } from './driver.js';");
  };
  await nest();
  const driver=router(projects,source); t.after(()=>driver.close());
  const p=project(); await driver.prepare(p,p.recipe);
  const old=JSON.parse(await readFile(join(projects,p.id,"project.json"),"utf8"));
  await writeFile(join(projects,p.id,"keep-data.txt"),"user data");
  await recipePackage(root,{marker:"v2",version:"2.0.0"});
  await nest();
  const next={...p,recipe:{...p.recipe,version:"2.0.0"}};
  await driver.prepare(next,next.recipe);
  assert.match(driver.capabilities(next).description,/acme v2/);
  const upgraded=JSON.parse(await readFile(join(projects,p.id,"project.json"),"utf8"));
  assert.equal(upgraded.recipe.version,"2.0.0");
  assert.notEqual(upgraded.recipe.artifact.digest,old.recipe.artifact.digest);
  await driver.close();
  const restarted=router(projects,source); t.after(()=>restarted.close());
  await restarted.adopt();
  assert.match(restarted.capabilities(next).description,/acme v2/);
  assert.equal((await restarted.start(next)).status,"running");
  assert.equal(await readFile(join(projects,p.id,"keep-data.txt"),"utf8"),"user data");
});

test("a failed custom recipe upgrade retains its original descriptor, artifact and data", async (t) => {
  const root=await scratch(t); const source=await recipePackage(root); const projects=join(root,"projects");
  const driver=router(projects,source); t.after(()=>driver.close()); const p=project();
  await driver.prepare(p,p.recipe);
  const descriptor=await readFile(join(projects,p.id,"project.json"),"utf8");
  const manifest=await readFile(join(projects,p.id,".zelavis","recipe","package","package.json"),"utf8");
  await recipePackage(root,{marker:"broken",version:"2.0.0",failPrepare:true});
  const next={...p,recipe:{...p.recipe,version:"2.0.0"}};
  await assert.rejects(driver.prepare(next,next.recipe),/candidate preparation failed/);
  assert.equal(await readFile(join(projects,p.id,"project.json"),"utf8"),descriptor);
  assert.equal(await readFile(join(projects,p.id,".zelavis","recipe","package","package.json"),"utf8"),manifest);
  assert.match(driver.capabilities(p).description,/acme v1/);
  await driver.close();
  const restarted=router(projects,source); t.after(()=>restarted.close());
  assert.equal((await restarted.start(p)).status,"running");
});

test("a recipe that failed before writing a descriptor can be cleaned up before and after restart", async (t) => {
  const root=await scratch(t); const source=await recipePackage(root,{failPrepare:true}); const projects=join(root,"projects");
  const driver=router(projects,source); const p=project();
  await assert.rejects(driver.prepare(p,p.recipe),/candidate preparation failed/);
  await rm(join(projects, p.id, "project.json")); // Historical early failure with no host descriptor.
  assert.equal((await driver.stop(p.id)).status,"stopped");
  await driver.close();
  const restarted=router(projects,source); t.after(()=>restarted.close());
  assert.equal((await restarted.stop(p.id)).status,"stopped");
  await restarted.destroy(p.id);
  await assert.rejects(access(join(projects,p.id)),{code:"ENOENT"});
});


test("custom cleanup failures remain retryable instead of deleting the Project directory", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root, { failDestroy: true });
  const projects = join(root, "projects");
  const driver = router(projects, source);
  t.after(() => driver.close());
  const p = project();
  await driver.prepare(p, p.recipe);
  await assert.rejects(driver.destroy(p.id), /recipe cleanup failed/);
  await access(join(projects, p.id, "project.json"));
});

test("an unreadable descriptor is refused during cleanup, preserving Project files", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root);
  const projects = join(root, "projects");
  const driver = router(projects, source);
  t.after(() => driver.close());
  const p = project();
  await driver.prepare(p, p.recipe);
  await writeFile(join(projects, p.id, "project.json"), "invalid JSON");
  await assert.rejects(driver.stop(p.id), SyntaxError);
  await assert.rejects(driver.destroy(p.id), SyntaxError);
  await access(join(projects, p.id));
});

test("missing-descriptor cleanup stops only the Agent's exact Project workload before removing files", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root, { failPrepare: true });
  const projects = join(root, "projects");
  const first = router(projects, source);
  const p = project();
  await assert.rejects(first.prepare(p, p.recipe), /candidate preparation failed/);
  await rm(join(projects, p.id, "project.json"));
  await first.close();
  let wrongWorkload = true;
  let stopped = false;
  const reclaimed = [];
  const driver = createLocalProjectRuntime({
    directory: projects,
    agent: {
      survivesControlPlaneRestart: true,
      attach: async id => [{ process: { workloadId: wrongWorkload ? "another-project" : id, stop: async () => { stopped = true; } } }],
      reclaim: async id => { reclaimed.push(id); },
      close: async () => {},
    },
  });
  t.after(() => driver.close());
  await assert.rejects(driver.destroy(p.id), /another Project's process/);
  assert.equal(stopped, false);
  assert.deepEqual(reclaimed, []);
  await access(join(projects, p.id));
  wrongWorkload = false;
  await driver.destroy(p.id);
  assert.equal(stopped, true);
  assert.deepEqual(reclaimed, [p.id]);
  await assert.rejects(access(join(projects, p.id)), { code: "ENOENT" });
});


test("failed provisioning records its trusted driver so custom cleanup still runs after restart", async (t) => {
  const root = await scratch(t);
  const source = await recipePackage(root, { failPrepare: true, failDestroy: true });
  const projects = join(root, "projects");
  const first = router(projects, source);
  const p = project();
  await assert.rejects(first.prepare(p, p.recipe), /candidate preparation failed/);
  await first.close();
  const restarted = router(projects, source);
  t.after(() => restarted.close());
  await assert.rejects(restarted.destroy(p.id), /recipe cleanup failed/);
  await access(join(projects, p.id));
});

test("a frozen Effect recipe resolves host packages and retains native interruption through the router", async (t) => {
  const { Deferred, Effect, Fiber } = await import("effect");
  const { effectOperations } = await import("../dist/core/runtime/effect-boundary.js");
  const root = await scratch(t), source = await recipePackage(root), projects = join(root, "projects");
  await writeFile(join(source, "dist", "runtime.js"), `
import { Effect } from "effect";
import { defineEffectProjectRuntime } from "zelavis/adapters/project-runtime";
export function createProjectRuntime({ options }) {
  return defineEffectProjectRuntime({
    name: "effect-recipe", runtimeKinds: ["native"], defaultRuntimeKind: "native",
    capabilities: () => ({ description: Effect.runSync(Effect.succeed("host Effect")) }),
    prepare: () => Effect.void,
    start: () => Effect.gen(function* () { options.entered(); yield* Effect.never; }).pipe(Effect.ensuring(Effect.sync(options.released))),
    stop: () => Effect.succeed({ status: "stopped" }), status: () => Effect.succeed({ status: "stopped" }),
    logs: () => Effect.succeed([]), destroy: () => Effect.void, close: () => Effect.void,
  });
}
`);
  const entered = Deferred.makeUnsafe();
  let released = false;
  const driver = router(projects, source, { options: { "@acme/site": {
    entered: () => Effect.runSync(Deferred.succeed(entered, undefined)), released: () => { released = true; },
  } } });
  t.after(() => driver.close());
  const p = project();
  await driver.prepare(p, p.recipe);
  assert.equal(driver.capabilities(p).description, "host Effect");
  const fiber = Effect.runFork(effectOperations(driver).start(p));
  await Effect.runPromise(Deferred.await(entered));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(released, true);
});


const managedRecipePackage = (root, options = {}) => recipePackage(root, {
  managed: { adminTitle: "Admin " + (options.version ?? "1.0.0"), adminPath: "/admin/" }, ...options,
});

async function managedUpdateFixture(t) {
  const root = await scratch(t), source = await managedRecipePackage(root), projects = join(root, "projects");
  const driver = router(projects, source); t.after(() => driver.close());
  const base = { ...project(), desiredState: "running", runtime: { driver: "local-project", status: "running", url: "http://127.0.0.1:1" } };
  base.recipe.managed = { adminTitle: "Original admin", adminPath: "/admin/" };
  await driver.prepare(base, base.recipe);
  const previous = JSON.parse(await readFile(join(projects, "site", "project.json"), "utf8"));
  await driver.start(previous);
  const prepared = await readFile(join(projects, "site", "prepared-by.txt"), "utf8");
  const candidate = { ...previous, recipe: { ...previous.recipe, version: "2.0.0", artifact: undefined, managed: { adminTitle: "New integration admin", adminPath: "/new-admin/" } } };
  return { root, source, projects, driver, previous, candidate, prepared };
}

test("managed recipe updates replace integration metadata without provisioning, start or stop", async t => {
  const f = await managedUpdateFixture(t);
  // Any accidental call to the new runtime's prepare would fail this update.
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0", failPrepare: true });
  const original = await readFile(join(f.projects, "site", "project.json"), "utf8");
  const update = await f.driver.prepareUpdate(f.previous, f.candidate);
  assert.equal(update.mode, "integration");
  assert.equal(await readFile(join(f.projects, "site", "project.json"), "utf8"), original, "staging leaves the selected descriptor alone");
  const commits = [];
  const snapshot = await f.driver.applyUpdate("site", update, async choice => commits.push(choice));
  assert.deepEqual(commits, ["target"]);
  assert.equal(snapshot.status, "running"); assert.equal(snapshot.url, f.previous.runtime.url);
  const selected = JSON.parse(await readFile(join(f.projects, "site", "project.json"), "utf8"));
  assert.equal(selected.recipe.version, "2.0.0"); assert.equal(selected.recipe.managed.adminTitle, "New integration admin");
  assert.equal(await readFile(join(f.projects, "site", "prepared-by.txt"), "utf8"), f.prepared);
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
  assert.equal((await f.driver.status("site")).status, "running");
});

test("a rejected integration commit restores the old artifact and leaves the app running", async t => {
  const f = await managedUpdateFixture(t);
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0" });
  const update = await f.driver.prepareUpdate(f.previous, f.candidate), commits = [];
  await assert.rejects(f.driver.applyUpdate("site", update, async choice => {
    commits.push(choice); if (choice === "target") throw Error("registry rejected integration commit");
  }), /registry rejected/);
  assert.deepEqual(commits, ["target", "previous"]);
  assert.equal(JSON.parse(await readFile(join(f.projects, "site", "project.json"), "utf8")).recipe.version, "1.0.0");
  assert.equal((await f.driver.status("site")).status, "running");
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
});

test("interrupted integration recovery repairs a missing canonical artifact without provisioning", async t => {
  const f = await managedUpdateFixture(t);
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0" });
  const update = await f.driver.prepareUpdate(f.previous, f.candidate);
  await f.driver.applyUpdate("site", update, async () => {});
  const canonical = join(f.projects, "site", ".zelavis", "recipe");
  // Power loss in the canonical-file presentation, with durable intent retained.
  await rename(canonical, canonical + ".previous-interrupted");
  await f.driver.close();
  const restarted = router(f.projects, f.source); t.after(() => restarted.close());
  assert.equal(await restarted.recoverUpdate("site", update), "target");
  assert.equal(JSON.parse(await readFile(join(f.projects, "site", "project.json"), "utf8")).recipe.version, "2.0.0");
  assert.equal(await readFile(join(f.projects, "site", "prepared-by.txt"), "utf8"), f.prepared);
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
});

test("an integration update refuses deployment contract changes without disturbing the app", async t => {
  const f = await managedUpdateFixture(t);
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0", runtime: "./dist/other.js" });
  await assert.rejects(f.driver.prepareUpdate(f.previous, f.candidate), /deployment contract/);
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0" });
  await assert.rejects(f.driver.prepareUpdate(f.previous, { ...f.candidate, recipe: { ...f.candidate.recipe, hostPackages: ["other-packages"] } }), /deployment contract/);
  const manifestFile = join(f.source, "package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.zelavis.project.hostPackages = ["unadvertised-packages"];
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(f.driver.prepareUpdate(f.previous, { ...f.candidate, recipe: { ...f.candidate.recipe, managed: undefined } }), /deployment contract/);
  assert.equal((await f.driver.status("site")).status, "running");
  assert.equal(JSON.parse(await readFile(join(f.projects, "site", "project.json"), "utf8")).recipe.version, "1.0.0");
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
});

test("the selected integration implementation is used on the next ordinary app start", async t => {
  const f = await managedUpdateFixture(t);
  await managedRecipePackage(f.root, { managed: f.candidate.recipe.managed, marker: "v2", version: "2.0.0" });
  const update = await f.driver.prepareUpdate(f.previous, f.candidate);
  await f.driver.applyUpdate("site", update, async () => {});
  await f.driver.stop("site");
  const selected = JSON.parse(await readFile(join(f.projects, "site", "project.json"), "utf8"));
  await f.driver.prepare(selected, selected.recipe); await f.driver.start(selected);
  assert.match(await readFile(join(f.projects, "site", "prepared-by.txt"), "utf8"), /^v2:/);
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\nstop:v1\nstart:v2\n");
});


async function managedPlatform(t, store, driver, version, advertiseManaged = true) {
  const zv = await zelavis({ subsystems: { fabric: false }, systemStore: store, projectRuntime: driver, serviceRegistry: { catalog: [{
    service: { name: "@acme/site", version, kind: "app", project: { runtimeKinds: ["native"], ...(advertiseManaged ? { managed: { adminTitle: "Admin " + version, adminPath: "/admin/" } } : {}) } },
    status: "available", source: "community", specifier: "@acme/site",
  }] } });
  t.after(() => zv.close());
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => zv.fetch(new Request(url, init), {
    principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
  }) });
  return { zv, client };
}

test("SDK/HTTP integration updates recover the proved host selection after a failed final registry write", async t => {
  const root = await scratch(t), source = await managedRecipePackage(root), projects = join(root, "projects");
  const driver = router(projects, source), store = createMemorySystemStore();
  let fail = false;
  const guarded = { ...store, async set(namespace, id, value) {
    if (fail && namespace === "projects" && id === "site" && value.recipe?.version === "2.0.0" && !value.runtimeUpdate) {
      fail = false; throw Error("final integration commit failed");
    }
    return store.set(namespace, id, value);
  } };
  const old = await managedPlatform(t, guarded, driver, "1.0.0");
  const original = await old.client.projects.create({ id: "site", name: "Managed site", recipeName: "@acme/site", start: true });
  await managedRecipePackage(root, { marker: "v2", version: "2.0.0", failPrepare: true });
  const next = await managedPlatform(t, guarded, driver, "2.0.0", false);
  assert.equal((await next.client.projects.recipes()).find(r => r.name === "@acme/site").managed, undefined, "Catalogue metadata is deliberately incomplete");
  const before = await next.client.projects.get("site");
  assert.equal(before.capabilities.recipeUpdateMode, "integration");
  fail = true;
  await assert.rejects(next.client.projects.upgrade("site"), { status: 500 });
  const restored = await next.client.projects.get("site");
  assert.equal(restored.recipe.version, "2.0.0"); assert.equal(restored.runtimeUpdate, undefined);
  assert.equal(restored.runtime.status, "running"); assert.equal(restored.runtime.url, original.runtime.url);
  const upgraded = restored;
  await assert.rejects(next.client.projects.upgrade("site"), { status: 409 });
  assert.equal(upgraded.recipe.version, "2.0.0"); assert.equal(upgraded.recipe.managed.adminTitle, "Admin 2.0.0");
  assert.equal(upgraded.runtime.status, "running"); assert.equal(upgraded.runtime.url, original.runtime.url);
  assert.equal(upgraded.runtimeUpdate, undefined);
  assert.equal(await readFile(join(projects, "site", "workload-events"), "utf8"), "start:v1\n");
  await assert.rejects(next.client.projects.switchVersion("site", "2.0.0"), { status: 400 });
});

test("stopped managed projects update their integration without provisioning or starting the app", async t => {
  const root = await scratch(t), source = await managedRecipePackage(root), projects = join(root, "projects");
  const driver = router(projects, source), store = createMemorySystemStore();
  const old = await managedPlatform(t, store, driver, "1.0.0");
  await old.client.projects.create({ id: "site", name: "Managed site", recipeName: "@acme/site", start: false });
  const prepared = await readFile(join(projects, "site", "prepared-by.txt"), "utf8");
  await managedRecipePackage(root, { marker: "v2", version: "2.0.0", failPrepare: true });
  const next = await managedPlatform(t, store, driver, "2.0.0");
  const upgraded = await next.client.projects.upgrade("site");
  assert.equal(upgraded.runtime.status, "stopped"); assert.equal(upgraded.recipe.version, "2.0.0");
  assert.equal(await readFile(join(projects, "site", "prepared-by.txt"), "utf8"), prepared);
  await assert.rejects(access(join(projects, "site", "workload-events")), { code: "ENOENT" });
});


test("managed SDK menus, REST, setup endpoints and disk pages activate through the Project Gateway without app lifecycle calls", { timeout: 30_000 }, async t => {
  const f = await managedUpdateFixture(t);
  let record = f.previous;
  const forward = createProjectForwarder({ projects: {
    get: async () => record,
    gatewayTarget: () => f.driver.gatewayTarget(record),
    signGatewayAuthority: (id, claims) => f.driver.signGatewayAuthority(id, claims),
  }, fabric: {
    getProjectPlacement: async () => ({ identity: { type: "project", workloadId: "site", scopeId: "platform" }, state: "active", generation: 1, runtimeNodeId: "local" }),
    getNode: async () => ({ status: "ready" }),
  }, unavailableProjectsResponse: () => ({ status: 503 }) });
  const exchange = path => forward({ projectId: "site", wildcardPath: path.replace(/^\//, ""), query: new URLSearchParams(),
    request: new Request("http://localhost" + path), principal: { id: "reader", type: "user" }, permissions: ["site.read"], allowFrontend: false });
  const fetcher = async path => { const r = await exchange(path); return new Response(r.body, { status: r.status, headers: r.headers }); };
  const get = async path => { const r = await fetcher(path); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const selected = async revision => {
    const config = await get("/zelavis/api/v1/runtime/config");
    const service = config.services.find(s => s.name === "@acme/site");
    assert.equal(service.menus[0].title, "Integration " + revision);
    assert.deepEqual((await get(service.apiPath + "/revision")).revision, revision);
    assert.equal((await get("/zelavis/api/v1/setup/")).revision, revision);
    const page = await fetcher(service.menus[0].page.src);
    assert.equal(page.status, 200); assert.match(await page.text(), new RegExp("Integration " + revision));
    return service.apiPath;
  };
  const api = await selected("v1");
  const denied = await forward({ projectId: "site", wildcardPath: (api + "/revision").slice(1), query: new URLSearchParams(),
    request: new Request("http://localhost" + api + "/revision"), principal: { id: "denied", type: "user" }, permissions: [], allowFrontend: false });
  assert.equal(denied.status, 403);
  await managedRecipePackage(f.root, { marker: "v2", version: "2.0.0" });
  const update = await f.driver.prepareUpdate(record, f.candidate);
  let done = false, hits = 0;
  const traffic = (async () => { do { await get(api + "/revision"); hits++; } while (!done); })();
  try { await f.driver.applyUpdate("site", update, async choice => { record = { ...(choice === "target" ? f.candidate : f.previous), recipe: choice === "target" ? update.recipe : f.previous.recipe }; }); }
  finally { done = true; await traffic; }
  assert.ok(hits > 0); await selected("v2");
  assert.equal((await fetcher(api + "/v1")).status, 404);
  assert.equal((await get(api + "/v2")).revision, "v2");
  // SDK discovery must re-read the active catalogue on the same client.
  const sdk = createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => fetcher(new URL(url).pathname) });
  assert.equal((await sdk.plugins.acmesite.revision.get()).revision, "v2");
  await managedRecipePackage(f.root, { marker: "v3", version: "3.0.0" });
  const third = await f.driver.prepareUpdate(record, { ...record, recipe: { ...record.recipe, version: "3.0.0", artifact: undefined } });
  await assert.rejects(f.driver.applyUpdate("site", third, async choice => {
    if (choice === "target") throw Error("registry rejected v3");
    record = { ...record, recipe: update.recipe };
  }), /registry rejected v3/);
  await selected("v2"); assert.equal((await sdk.plugins.acmesite.revision.get()).revision, "v2");
  assert.equal((await fetcher(api + "/v3")).status, 404);
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
  assert.equal(await readFile(join(f.projects, "site", "prepared-by.txt"), "utf8"), f.prepared);
  const address = await f.driver.gatewayTarget(record);
  await f.driver.destroy("site");
  await assert.rejects(fetch(address + "/zelavis/api/v1/runtime/config"));
  await assert.rejects(access(join(f.projects, "site")), { code: "ENOENT" });
});


test("managed adoption claims Agent custody once and shares it with the app supervisor", async t => {
  const root = await scratch(t), source = await managedRecipePackage(root), projects = join(root, "projects");
  await writeFile(join(source, "dist/runtime.js"), `
export function createProjectRuntime({ agent }) {
  let children = [];
  return { name: "custody-proof", capabilities: () => ({ survivesControlPlaneRestart: true }),
    async prepare() {}, async start() {}, async stop() {}, async logs() { return []; }, async destroy() {}, async close() {},
    async adopt() { children = await agent.attach("site"); },
    async status() { return children.length === 3 && children.every(entry => entry.process.running)
      ? { status: "running", url: "http://127.0.0.1:1234" } : { status: "stopped" }; }
  };
}`);
  let claims = 0;
  const agent = { survivesControlPlaneRestart: true, async close() {}, async attach(id) {
    claims++;
    return claims === 1 ? ["database", "php", "nginx"].map(name => ({
      process: { id: name, workloadId: id, running: true },
      command: { workloadId: id, executable: name, cwd: projects, args: [] }, replay: [],
    })) : [];
  } };
  const first = router(projects, source, { agent }); t.after(() => first.close());
  const descriptor = project(); descriptor.recipe.managed = { adminTitle: "Admin", adminPath: "/admin/" };
  await first.prepare(descriptor, descriptor.recipe);
  const restarted = router(projects, source, { agent }); t.after(() => restarted.close());
  await restarted.adopt();
  assert.equal(claims, 1, "Agent custody must be claimed once across both supervisors");
  assert.deepEqual(await restarted.status("site"), { status: "running", url: "http://127.0.0.1:1234" });
});

test("a surviving managed integration host is re-keyed and repairs an interrupted canonical recipe swap", { timeout: 30_000 }, async t => {
  const root = await scratch(t), source = await managedRecipePackage(root), projects = join(root, "projects");
  const backing = createLocalAgentProcessRunner(), attached = [];
  const agent = { ...backing, survivesControlPlaneRestart: true, attach: async id => attached.filter(entry => entry.process.workloadId === id && entry.process.running),
    start: async (command, options) => {
      const replay = []; let listener;
      const child = await backing.start(command, { ...options, onOutput: event => { replay.push(event); if (listener) listener(event); else options.onOutput?.(event); } });
      const process = { ...child, get running() { return child.running; }, listen: handler => { listener = handler; } };
      attached.push({ process, command, replay }); return process;
    },
  };
  t.after(() => backing.close());
  const first = router(projects, source, { agent }); t.after(() => first.close());
  let previous = { ...project(), desiredState: "running", runtime: { status: "running", url: "http://127.0.0.1:1" } };
  previous.recipe.managed = { adminTitle: "Admin", adminPath: "/admin/" };
  await first.prepare(previous, previous.recipe); await first.start(previous);
  previous = JSON.parse(await readFile(join(projects, "site/project.json"), "utf8"));
  const address = await first.gatewayTarget(previous);
  const oldAuthority = await first.signGatewayAuthority("site", { projectId: "site", scopeId: "platform", generation: 1,
    runtimeNodeId: "local", subject: "reader", subjectType: "user", tenantId: "tenant", permissions: ["site.read"] });
  await managedRecipePackage(root, { marker: "v2", version: "2.0.0" });
  const target = { ...previous, recipe: { ...previous.recipe, version: "2.0.0", artifact: undefined } };
  const update = await first.prepareUpdate(previous, target);
  await first.applyUpdate("site", update, async () => {});
  await rename(join(projects, "site/.zelavis/recipe"), join(projects, "site/.zelavis/recipe.previous-interrupted"));
  const restarted = router(projects, source, { agent }); t.after(() => restarted.close());
  await restarted.adopt();
  assert.equal(await restarted.recoverUpdate("site", update), "target");
  const selected = JSON.parse(await readFile(join(projects, "site/project.json"), "utf8"));
  assert.equal(await restarted.gatewayTarget(selected), address);
  const denied = await fetch(address + "/zelavis/api/v1/plugins/acmesite/revision", { headers: { "x-zelavis-authority": oldAuthority } });
  assert.equal(denied.status, 401); await denied.text();
  const authority = await restarted.signGatewayAuthority("site", { projectId: "site", scopeId: "platform", generation: 1,
    runtimeNodeId: "local", subject: "reader", subjectType: "user", tenantId: "tenant", permissions: ["site.read"] });
  const active = await fetch(address + "/zelavis/api/v1/plugins/acmesite/revision", { headers: { "x-zelavis-authority": authority } });
  assert.equal(active.status, 200); assert.equal((await active.json()).revision, "v2");
  assert.equal(attached.length, 1, "Adoption must retain the same integration host");
  assert.equal(await readFile(join(projects, "site/workload-events"), "utf8"), "start:v1\n");
});

test("managed apps provide ordinary private APIs by default and retain usage and data through recipe handover", { timeout: 30_000 }, async t => {
  const f = await managedUpdateFixture(t);
  let record = f.previous;
  const forward = createProjectForwarder({ projects: {
    get: async () => record, gatewayTarget: () => f.driver.gatewayTarget(record),
    signGatewayAuthority: (id, claims) => f.driver.signGatewayAuthority(id, claims),
  }, fabric: {
    getProjectPlacement: async () => ({ identity: { type: "project", workloadId: "site", scopeId: "platform" }, state: "active", generation: 1, runtimeNodeId: "local" }),
    getNode: async () => ({ status: "ready" }),
  }, unavailableProjectsResponse: () => ({ status: 503 }) });
  const request = async (path, init = {}, permissions = ["site.read", "site.write", "project.users.manage", "storage.read", "storage.write", "workloads.view", "workloads.manage", "database.read", "database.inspect"]) => {
    const url = new URL(path, "http://localhost");
    const result = await forward({ projectId: "site", wildcardPath: url.pathname.slice(1), query: url.searchParams,
      request: new Request(url, init), principal: { id: "owner", type: "user" }, permissions, allowFrontend: false });
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
  const json = async (path, init) => { const response = await request(path, init); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const configuration = () => json("/zelavis/api/v1/runtime/config");
  let config = await configuration();
  for (const domain of ["database", "identity", "storage", "workloads"]) assert.deepEqual(config.capabilities[domain], { available: true, used: false });
  assert.equal(config.capabilities.fabric.available, false, "A bound App must never acquire parent Fabric authority");
  assert.equal((await request("/zelavis/api/v1/auth/accounts", {}, [])).status, 403);
  assert.equal((await configuration()).capabilities.identity.used, false, "Denied requests do not reveal menus");
  assert.equal((await request("/zelavis/api/v1/database/not-a-real-api")).status, 404);
  assert.equal((await configuration()).capabilities.database.used, false);
  await managedRecipePackage(f.root, { marker: "v2", version: "2.0.0", backend: true });
  const update = await f.driver.prepareUpdate(record, f.candidate);
  await f.driver.applyUpdate("site", update, async choice => { record = { ...(choice === "target" ? f.candidate : f.previous), recipe: choice === "target" ? update.recipe : f.previous.recipe }; });
  config = await configuration();
  assert.equal(config.capabilities.database.used, true, "An ordinary setup API call automatically reveals its native section");
  assert.equal(config.capabilities.identity.used, false, "Merely receiving Auth in the setup context is not usage");
  for (const capability of ["database", "identity", "storage", "workloads"]) {
    assert.equal((await json("/zelavis/api/v1/integration-native/" + capability, { method: "POST" })).exercised, capability);
  }
  const checkData = async () => {
    const active = await configuration();
    for (const domain of ["database", "identity", "storage", "workloads"]) assert.deepEqual(active.capabilities[domain], { available: true, used: true });
    const accounts = await json("/zelavis/api/v1/auth/accounts");
    assert.ok(accounts.some(account => account.id === "integration-user"));
    assert.equal(await (await request("/zelavis/api/v1/storage/files/integration-proof.txt")).text(), "private storage");
    const workloads = await json("/zelavis/api/v1/workloads/?projectId=site");
    assert.ok(workloads.workloads.some(workload => workload.id === "integration-job"));
    const stored = await readFile(join(f.projects, "site", ".zelavis", "integration", "files", "integration-proof.txt"), "utf8");
    assert.equal(stored, "private storage");
  };
  await checkData();
  await managedRecipePackage(f.root, { marker: "v3", version: "3.0.0" });
  const third = await f.driver.prepareUpdate(record, { ...record, recipe: { ...record.recipe, version: "3.0.0", artifact: undefined } });
  await f.driver.applyUpdate("site", third, async choice => { if (choice === "target") record = { ...record, recipe: third.recipe }; });
  await checkData();
  assert.equal(await readFile(join(f.projects, "site", "workload-events"), "utf8"), "start:v1\n");
  assert.equal(await readFile(join(f.projects, "site", "prepared-by.txt"), "utf8"), f.prepared);
  await f.driver.stop("site");
  await f.driver.start(record);
  await checkData();
  await f.driver.destroy("site");
  await assert.rejects(access(join(f.projects, "site")), { code: "ENOENT" });
});
