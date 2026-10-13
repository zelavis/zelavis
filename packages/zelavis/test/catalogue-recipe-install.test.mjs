// A recipe only listed in the Marketplace catalogue carries no install manifest. Installing it acquires the
// package, and from then on the installed package, not the listing, is the recipe Projects are created from.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createMemoryServiceRegistryStore } from "../dist/platform/settings.js";
import { createLocalRuntimeServiceManifestResolver } from "../dist/adapters/_local-runtime.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };
const NAME = "@acme/wiki";
const REFERENCE = `npm:${NAME}@1.0.0`;

const install = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./recipe.js", requires: [] }],
  software: [{ version: "1.0.0", archive: "https://example.com/wiki-1.0.0.tgz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
};

// What the allow-list says about the package: identity and runtime kinds, never its install methods.
const listing = {
  service: { name: NAME, kind: "app", version: "1.0.0", marketplace: { title: "Wiki" }, project: { runtimeKinds: ["native"] } },
  specifier: REFERENCE,
  status: "available",
  source: "community",
  maintainer: "zelavis",
  order: 50,
};

function projectRuntime() {
  return {
    name: "test-runtime",
    runtimeKinds: ["native"],
    capabilities: () => ({ statelessRuntimeReplicas: false }),
    async prepare() {},
    async start() { return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop() { return { status: "stopped" }; },
    async status() { return { status: "stopped" }; },
    async logs() { return []; },
    async destroy() {},
    async close() {},
  };
}

async function acquiredPackage(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-catalogue-recipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "package");
  await mkdir(directory);
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: NAME, version: "1.0.0", type: "module", exports: { ".": "./index.js" },
    zelavis: { kind: "app", namespace: "wiki", project: { runtimeKinds: ["native"], install } },
  }));
  await writeFile(join(directory, "index.js"), "export function register() {}\n");
  await writeFile(join(directory, "recipe.js"), "export default {};\n");
  return join(directory, "index.js");
}

test("an installed catalogue recipe replaces its listing at once, so a Project created from it is locked with install methods", async (t) => {
  const specifier = await acquiredPackage(t);
  const systemStore = createMemorySystemStore();
  const registryStore = createMemoryServiceRegistryStore([]);
  const compose = () => zelavis({
    systemStore,
    subsystems: { auth: false, database: false },
    serviceRegistry: { store: registryStore, catalog: [listing], manifestResolver: createLocalRuntimeServiceManifestResolver() },
    servicePackageInstaller: {
      install: () => Effect.die(new Error("not used")),
      acquire: ({ reference }) => {
        assert.equal(reference, REFERENCE);
        return Effect.succeed({ specifier, resolved: REFERENCE, integrity: "sha512-test" });
      },
    },
    projectRuntime: projectRuntime(),
  });
  const before = await compose();
  t.after(() => before.close());
  const call = (runtime, path, init) => runtime.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, {
    ...init, headers: { "content-type": "application/json" },
  }), OWNER);
  const recipeStatus = async (runtime) =>
    (await (await call(runtime, "/runtime/project-recipes")).json()).projectRecipes.find((entry) => entry.name === NAME)?.status;

  assert.equal(await recipeStatus(before), "available");
  const refused = await call(before, "/runtime/projects", { method: "POST", body: JSON.stringify({ name: "Early", recipeName: NAME, start: false }) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /not installed yet/);

  const installed = await call(before, "/runtime/services", { method: "POST", body: JSON.stringify({ packageSource: REFERENCE, status: "installed" }) });
  assert.equal(installed.status, 201, await installed.text());
  const services = await (await call(before, "/runtime/services")).json();
  const listed = (services.services ?? services).find((entry) => entry.name === NAME);
  assert.equal(listed.status, "installed");
  assert.equal(listed.installVia, undefined, "no longer something to acquire");

  // A running Platform keeps serving the runtime it composed at start: the installed recipe is read live.
  assert.equal(await recipeStatus(before), "installed");
  const created = await call(before, "/runtime/projects", { method: "POST", body: JSON.stringify({ name: "Wiki", recipeName: NAME, start: false }) });
  const body = await created.json();
  assert.equal(created.status, 201, JSON.stringify(body));
  const project = body.project ?? body;
  assert.equal(project.recipe.name, NAME);
  assert.equal(project.recipe.install?.method, "native");
  assert.equal(project.recipe.install?.software, "1.0.0");

  // Composed again, the installed package is part of the composed registry and keeps its extension scope.
  const after = await compose();
  t.after(() => after.close());
  assert.equal(await recipeStatus(after), "installed");
  const recomposed = await (await call(after, "/runtime/services")).json();
  assert.equal((recomposed.services ?? recomposed).find((entry) => entry.name === NAME).scope, "extension",
    "an installed package stays extension-scoped once it is part of the composed registry");
});

test("a listing whose package failed to load is not reported installed", async (t) => {
  const systemStore = createMemorySystemStore();
  const registryStore = createMemoryServiceRegistryStore([
    { name: NAME, specifier: join(tmpdir(), "zelavis-missing-package", "index.js"), status: "installed", source: "community" },
  ]);
  const runtime = await zelavis({
    systemStore,
    subsystems: { auth: false, database: false },
    serviceRegistry: { store: registryStore, catalog: [listing], manifestResolver: createLocalRuntimeServiceManifestResolver() },
    projectRuntime: projectRuntime(),
  });
  t.after(() => runtime.close());
  const response = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/project-recipes"), OWNER);
  assert.equal((await response.json()).projectRecipes.find((entry) => entry.name === NAME).status, "available");
  const created = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Wiki", recipeName: NAME, start: false }),
  }), OWNER);
  assert.equal(created.status, 400);
  assert.match((await created.json()).error, /not installed yet/);
});
