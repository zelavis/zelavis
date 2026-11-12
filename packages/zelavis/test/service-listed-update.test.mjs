// An installed service the marketplace's allow-list now lists at a newer version is offered as an update, and
// updating it is that version from then on, in the running Platform: a recipe's Projects offer its upgrade at
// once, without a restart. The version is the list's, never the caller's.
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

const install = (version) => ({
  contract: 2,
  methods: [{ id: "native", driver: "js", entry: "./recipe.js", requires: [] }],
  // Every recipe revision offers the same software, so a Project keeps its choice across them.
  software: [{ version: "1.0", archive: "https://example.com/wiki-1.0.tgz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
});

const listing = (version) => ({
  service: { name: NAME, kind: "app", version, marketplace: { title: "Wiki" }, project: { runtimeKinds: ["native"] } },
  specifier: `npm:${NAME}@${version}`,
  status: "available",
  source: "community",
  maintainer: "zelavis",
  order: 50,
});

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

async function packages(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-listed-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (version) => {
    const directory = join(root, version);
    await mkdir(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: NAME, version, type: "module", exports: { ".": "./index.js" },
      zelavis: { kind: "app", namespace: "wiki", project: { runtimeKinds: ["native"], install: install(version) } },
    }));
    await writeFile(join(directory, "index.js"), "export function register() {}\n");
    await writeFile(join(directory, "recipe.js"), "export default {};\n");
    return join(directory, "index.js");
  };
  return { "1.0.0": await write("1.0.0"), "2.0.0": await write("2.0.0") };
}

async function platform(t, { listed, installed = "1.0.0", stores }) {
  const specifiers = await packages(t);
  const acquired = [];
  const runtime = await zelavis({
    systemStore: stores?.system ?? createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    serviceRegistry: {
      // Installed when the Platform was composed: the case of every server that updated its Platform.
      store: stores?.registry ?? createMemoryServiceRegistryStore(installed
        ? [{ name: NAME, specifier: specifiers[installed], status: "installed", source: "community" }] : []),
      catalog: [listing(listed)],
      manifestResolver: createLocalRuntimeServiceManifestResolver(),
    },
    servicePackageInstaller: {
      install: () => Effect.die(new Error("not used")),
      acquire: ({ reference }) => {
        acquired.push(reference);
        const version = reference.slice(reference.lastIndexOf("@") + 1);
        return Effect.succeed({ specifier: specifiers[version], resolved: reference, integrity: "sha512-test" });
      },
    },
    projectRuntime: projectRuntime(),
  });
  t.after(() => runtime.close());
  const send = (url, init) => runtime.fetch(new Request(url, init), OWNER);
  const call = async (path, init) => {
    const response = await runtime.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, { ...init, headers: { "content-type": "application/json" } }), OWNER);
    return { status: response.status, body: await response.json() };
  };
  const wiki = async () => (await call("/runtime/services")).body.services.find((entry) => entry.name === NAME);
  return { call, wiki, acquired, specifiers, send };
}

test("an installed package the list offers at a newer version updates in the running Platform, the list's version only", async (t) => {
  const { call, wiki, acquired } = await platform(t, { listed: "2.0.0" });
  const before = await wiki();
  assert.equal(before.version, "1.0.0");
  assert.deepEqual(before.update, { version: "2.0.0" }, "the list offers a newer version");

  const updated = await call(`/runtime/services/${encodeURIComponent(NAME)}/update`, { method: "POST", body: JSON.stringify({ version: "9.9.9" }) });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.service, { name: NAME, from: "1.0.0", version: "2.0.0" });
  assert.deepEqual(acquired, [`npm:${NAME}@2.0.0`], "the list's version, whatever the request says");
  const after = await wiki();
  assert.equal(after.version, "2.0.0", "the running Platform serves the new version at once");
  assert.equal(after.update, undefined);

  const again = await call(`/runtime/services/${encodeURIComponent(NAME)}/update`, { method: "POST" });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /newest version the marketplace lists/);
});

test("a Project is created from the newest listed version of a recipe that is only listed, acquired first", async (t) => {
  const { call, acquired } = await platform(t, { listed: "2.0.0", installed: null });
  const created = await call("/runtime/projects", { method: "POST", body: JSON.stringify({ id: "docs", name: "Docs", recipeName: NAME, start: false }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.project.recipe.version, "2.0.0");
  assert.equal(created.body.project.recipe.install?.method, "native", "locked from the package, not the listing");
  assert.deepEqual(acquired, [`npm:${NAME}@2.0.0`]);
});

test("a Project made from an older recipe offers the newest listed version, and upgrading acquires it first", async (t) => {
  const stores = { system: createMemorySystemStore() };
  // Made while 1.0.0 was the newest the list held.
  const first = await platform(t, { listed: "1.0.0", stores: { system: stores.system } });
  const created = await first.call("/runtime/projects", { method: "POST", body: JSON.stringify({ id: "docs", name: "Docs", recipeName: NAME, start: false }) });
  assert.equal(created.body.project.recipe.version, "1.0.0");
  assert.deepEqual(first.acquired, [], "nothing newer to acquire");

  // The Platform updated; its list now names 2.0.0, and 1.0.0 is still what is installed.
  const later = await platform(t, { listed: "2.0.0", stores: { system: stores.system } });
  assert.deepEqual((await later.call("/runtime/projects/docs")).body.project.recipeStatus, { state: "upgradeAvailable", version: "2.0.0" });
  const upgraded = await later.call("/runtime/projects/docs/upgrade", { method: "POST", body: "{}" });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
  assert.equal(upgraded.body.project.recipe.version, "2.0.0");
  assert.deepEqual(later.acquired, [`npm:${NAME}@2.0.0`]);
  assert.equal((await later.wiki()).version, "2.0.0");
});

test("a Project whose recipe the server only lists (made when it came with the Platform) upgrades: the recipe is acquired first", async (t) => {
  const stores = { system: createMemorySystemStore() };
  const first = await platform(t, { listed: "1.0.0", stores });
  assert.equal((await first.call("/runtime/projects", { method: "POST", body: JSON.stringify({ id: "blogger", name: "Blogger", recipeName: NAME, start: false }) })).status, 201);
  // Nothing is installed any more; the list names 2.0.0.
  const later = await platform(t, { listed: "2.0.0", installed: null, stores });
  assert.equal((await later.wiki()).status, "available");
  assert.deepEqual((await later.call("/runtime/projects/blogger")).body.project.recipeStatus, { state: "upgradeAvailable", version: "2.0.0" });
  const upgraded = await later.call("/runtime/projects/blogger/upgrade", { method: "POST", body: JSON.stringify({ restart: true }) });
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
  assert.equal(upgraded.body.project.recipe.version, "2.0.0");
  assert.deepEqual(later.acquired, [`npm:${NAME}@2.0.0`]);
  assert.equal((await later.wiki()).status, "installed");
});

test("installing an installed package again at another version is that version at once", async (t) => {
  const { call, wiki } = await platform(t, { listed: "2.0.0" });
  const installed = await call("/runtime/services", { method: "POST", body: JSON.stringify({ packageSource: `npm:${NAME}@2.0.0`, status: "installed" }) });
  assert.equal(installed.status, 201, JSON.stringify(installed.body));
  assert.equal((await wiki()).version, "2.0.0");
});

test("nothing is offered when the list holds no newer version, and only installed services update", async (t) => {
  const { call, wiki, acquired } = await platform(t, { listed: "1.0.0" });
  assert.equal((await wiki()).update, undefined);
  const refused = await call(`/runtime/services/${encodeURIComponent(NAME)}/update`, { method: "POST" });
  assert.equal(refused.status, 409);
  const unknown = await call(`/runtime/services/${encodeURIComponent("@acme/missing")}/update`, { method: "POST" });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /not an installed service/);
  assert.deepEqual(acquired, []);
});

test("the SDK and the CLI list the same update and run the same operation as HTTP", async (t) => {
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runCli } = await import("../dist/cli/commands.js");
  const { send, call } = await platform(t, { listed: "2.0.0" });
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: send });
  const cli = async (...args) => {
    const original = { fetch: globalThis.fetch, log: console.log };
    const out = [];
    globalThis.fetch = send;
    console.log = (value) => out.push(value);
    try { await runCli(["marketplace", ...args, "--url", "http://localhost/zelavis", "--json"]); } finally { globalThis.fetch = original.fetch; console.log = original.log; }
    return JSON.parse(out.join("\n"));
  };

  const http = (await call("/runtime/services")).body.services;
  assert.deepEqual(await client.marketplace.services(), http);
  assert.deepEqual((await cli("updates")).map((service) => [service.name, service.update]), [[NAME, { version: "2.0.0" }]]);

  const viaCli = await cli("update", NAME);
  assert.deepEqual(viaCli.service, { name: NAME, from: "1.0.0", version: "2.0.0" });
  assert.deepEqual(await cli("updates"), []);
  await assert.rejects(client.marketplace.update(NAME), /newest version the marketplace lists/, "the SDK reports the same refusal");
});
