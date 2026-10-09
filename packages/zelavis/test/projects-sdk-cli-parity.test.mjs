import assert from "node:assert/strict";
import test from "node:test";

import { createHostOperationBroker, createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient, ZelavisClientHttpError } from "../dist/sdk/fetch.js";
import { createZelavisEdgePreviews } from "../dist/edge/previews.js";
import { createNodeEdgePreviewHost } from "../dist/adapters/_node-edge-previews.js";
import { runCli } from "../dist/cli/commands.js";
import { parseRecipeManifest } from "../dist/core/recipe/index.js";

const OWNER = { principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] } };

const BACKEND_CAPABILITIES = Object.freeze({
  isolationBoundary: "process",
  filesystemIsolation: "planned",
  processIsolation: "planned",
  networkIsolation: "planned",
  resourceControls: { cpu: "planned", memory: "planned", pids: "planned", disk: "planned" },
  exec: "available",
  persistentStorage: "available",
  snapshots: "planned",
  images: "unavailable",
  description: "test native backend",
});

function recipe(name, isolation) {
  return {
    service: {
      name,
      kind: "app",
      version: "1.0.0",
      marketplace: { title: name },
      project: { runtimeKinds: ["native"], ...(isolation ? { isolation } : {}) },
    },
    specifier: name,
    status: "available",
    source: "community",
  };
}

function projectRuntime() {
  const running = new Set();
  return {
    name: "test-runtime",
    runtimeKinds: ["native"],
    capabilities: () => ({ statelessRuntimeReplicas: false }),
    async prepare() {},
    async start(project) {
      running.add(project.id);
      return { status: "running", url: "http://127.0.0.1:1" };
    },
    async stop(projectId) {
      running.delete(projectId);
      return { status: "stopped" };
    },
    async status(projectId) {
      return running.has(projectId)
        ? { status: "running", url: "http://127.0.0.1:1" }
        : { status: "stopped" };
    },
    async logs(projectId) {
      return [{ timestamp: "2026-09-17T00:00:00.000Z", stream: "system", message: `log ${projectId}` }];
    },
    async destroy(projectId) { running.delete(projectId); },
    async setupValues(projectId, { reveal }) {
      return [
        { id: "db-host", label: "Database host", secret: false, value: `127.0.0.1:3306/${projectId}` },
        { id: "db-password", label: "Database password", secret: true, ...(reveal ? { value: "generated-secret" } : {}) },
      ];
    },
    async close() {},
  };
}

async function boot(t, options = {}) {
  const runtime = projectRuntime();
  const store = options.store ?? createMemorySystemStore();
  const zv = await zelavis({
    systemStore: store,
    ...(options.edgePreviews ? { edgePreviews: options.edgePreviews } : {}),
    ...(options.broker ? { hostOperations: options.broker } : {}),
    projectRuntime: runtime,
    deploymentBackends: [{
      id: "native",
      title: "Native",
      capabilities: BACKEND_CAPABILITIES,
      projectRuntime: runtime,
      detect: async () => ({ state: "ready", installed: true, healthy: true, checkedAt: new Date().toISOString() }),
    }],
    serviceRegistry: {
      catalog: [
        { ...recipe("acme/packages"), service: { ...recipe("acme/packages").service, project: { runtimeKinds: ["native"], hostPackages: ["wordpress-stack"] } } },
        recipe("acme/plain"),
        { ...recipe("acme/choosy"), service: { ...recipe("acme/choosy").service, project: { runtimeKinds: ["native"], install: parseRecipeManifest({
          contract: 1,
          methods: [
            { id: "native", driver: "js", entry: "./recipe.mjs", requires: [] },
            { id: "container", driver: "oci", image: `registry.example/app@sha256:${"a".repeat(64)}`, requires: ["docker"] },
          ],
          software: [
            { version: "7.1", archive: "https://example.com/7.1.tar.gz", sha256: "b".repeat(64), maxBytes: 1000 },
            { version: "6.9", archive: "https://example.com/6.9.tar.gz", sha256: "c".repeat(64), maxBytes: 1000 },
          ],
          ports: [{ name: "web", protocol: "http" }],
        }) } } },
        recipe("acme/advised", { network: "advisory" }),
        recipe("acme/vm-only", { boundary: { minimum: "microvm", enforcement: "required" } }),
      ],
    },
  });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), OWNER);
  return {
    zv,
    store,
    fetcher,
    client: createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher }),
  };
}

/** Runs the CLI against the runtime and returns parsed stdout/stderr JSON. */
async function cli(fetcher, args) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const out = [];
  const err = [];
  globalThis.fetch = fetcher;
  console.log = (value) => out.push(value);
  console.error = (value) => err.push(value);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runCli(["projects", ...args, "--url", "http://localhost/zelavis", "--json"]);
    return {
      exitCode: process.exitCode ?? 0,
      stdout: out.length ? JSON.parse(out.join("\n")) : undefined,
      stderr: err.length ? JSON.parse(err.join("\n")) : undefined,
    };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
}

const http = async (fetcher, method, path, body) => {
  const response = await fetcher(`http://localhost/zelavis/api/v1/runtime${path}`, {
    method,
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};

// Timestamps differ between independently created Projects; everything else
// must match across the three adapters.
const stable = (project) => {
  const { createdAt: _c, updatedAt: _u, id: _id, name: _n, runtime, ...rest } = project;
  const { startedAt: _s, stoppedAt: _st, ...runtimeRest } = runtime;
  return { ...rest, runtime: runtimeRest };
};

test("Project create, read and lifecycle are equivalent over HTTP, SDK and CLI", async (t) => {
  const { fetcher, client } = await boot(t);

  const viaHttp = await http(fetcher, "POST", "/projects", { name: "http-site", recipeName: "acme/advised" });
  assert.equal(viaHttp.status, 201);
  const viaSdk = await client.projects.create({ name: "sdk-site", recipeName: "acme/advised" });
  const viaCli = await cli(fetcher, ["create", "cli-site", "--recipe", "acme/advised"]);
  assert.equal(viaCli.exitCode, 0);
  assert.deepEqual(stable(viaSdk), stable(viaHttp.body.project));
  assert.deepEqual(stable(viaCli.stdout.project), stable(viaHttp.body.project));
  assert.equal(viaSdk.isolation.shortfalls[0].requirement, "network");

  const renamedHttp = await http(fetcher, "PATCH", "/projects/http-site", { name: "HTTP renamed" });
  assert.equal(renamedHttp.body.project.name, "HTTP renamed");
  assert.equal((await client.projects.update("sdk-site", { name: "SDK renamed" })).name, "SDK renamed");
  const renamedCli = await cli(fetcher, ["rename", "cli-site", "CLI renamed"]);
  assert.equal(renamedCli.exitCode, 0);
  assert.equal(renamedCli.stdout.project.name, "CLI renamed");

  const recipesHttp = await http(fetcher, "GET", "/project-recipes");
  assert.deepEqual(await client.projects.recipes(), recipesHttp.body.projectRecipes);
  assert.deepEqual((await cli(fetcher, ["recipes"])).stdout, recipesHttp.body);
  assert.deepEqual(
    recipesHttp.body.projectRecipes.find((entry) => entry.name === "acme/vm-only").isolation,
    { boundary: { minimum: "microvm", enforcement: "required" } },
  );

  for (const [action, method, suffix] of [
    ["stop", "POST", "/stop"],
    ["start", "POST", "/start"],
    ["restart", "POST", "/restart"],
    ["get", "GET", ""],
  ]) {
    const h = await http(fetcher, method, `/projects/http-site${suffix}`);
    assert.equal(h.status, 200, action);
    const s = await client.projects[action]("sdk-site");
    const c = await cli(fetcher, [action, "cli-site"]);
    assert.equal(c.exitCode, 0, action);
    assert.deepEqual(stable(s), stable(h.body.project), action);
    assert.deepEqual(stable(c.stdout.project), stable(h.body.project), action);
  }

  const logsHttp = await http(fetcher, "GET", "/projects/http-site/logs");
  assert.deepEqual(await client.projects.logs("http-site"), logsHttp.body.logs);
  assert.deepEqual((await cli(fetcher, ["logs", "http-site"])).stdout, logsHttp.body);

  const listHttp = await http(fetcher, "GET", "/projects");
  const listSdk = await client.projects.list();
  const listCli = (await cli(fetcher, ["list"])).stdout;
  const ids = (body) => body.projects.map((project) => project.id).sort();
  assert.deepEqual(ids(listSdk), ids(listHttp.body));
  assert.deepEqual(ids(listCli), ids(listHttp.body));
  assert.deepEqual(ids(listHttp.body), ["cli-site", "http-site", "sdk-site"]);

  assert.deepEqual((await http(fetcher, "DELETE", "/projects/http-site")).body, { deleted: true });
  assert.deepEqual(await client.projects.remove("sdk-site"), { deleted: true });
  assert.deepEqual((await cli(fetcher, ["remove", "cli-site"])).stdout, { deleted: true });
  assert.deepEqual((await client.projects.list()).projects, []);
});

test("required isolation refusal carries the same code and assessment everywhere", async (t) => {
  const { fetcher, client } = await boot(t);
  const input = { name: "vm", recipeName: "acme/vm-only" };

  const viaHttp = await http(fetcher, "POST", "/projects", input);
  assert.equal(viaHttp.status, 409);
  assert.equal(viaHttp.body.code, "project.isolation.unsatisfied");
  assert.deepEqual(viaHttp.body.isolation, {
    runtimeKind: "native",
    satisfied: false,
    shortfalls: [{ requirement: "boundary", enforcement: "required", expected: "microvm", actual: "process" }],
  });

  await assert.rejects(client.projects.create(input), (error) => {
    assert.ok(error instanceof ZelavisClientHttpError);
    assert.equal(error.response.status, 409);
    assert.deepEqual(error.body, viaHttp.body);
    return true;
  });

  const viaCli = await cli(fetcher, ["create", "vm", "--recipe", "acme/vm-only"]);
  assert.equal(viaCli.exitCode, 1);
  assert.equal(viaCli.stdout, undefined);
  assert.deepEqual(viaCli.stderr, { error: viaHttp.body.error, status: 409, details: viaHttp.body });

  assert.deepEqual((await client.projects.list()).projects, []);
});

test("validation, not-found and authorization failures are equivalent", async (t) => {
  const { zv, fetcher, client } = await boot(t);

  const missingHttp = await http(fetcher, "GET", "/projects/nope");
  assert.equal(missingHttp.status, 404);
  await assert.rejects(client.projects.get("nope"), (error) =>
    error.response.status === 404 && error.body.error === missingHttp.body.error);
  assert.deepEqual((await cli(fetcher, ["get", "nope"])).stderr, {
    error: missingHttp.body.error, status: 404, details: missingHttp.body,
  });
  await assert.rejects(client.projects.update("nope", { name: "Renamed" }), (error) =>
    error.response.status === 404);

  await client.projects.create({ name: "rename-validation", recipeName: "acme/advised", start: false });
  await assert.rejects(client.projects.update("rename-validation", { name: "" }), (error) =>
    error.response.status === 400);
  const missingRenameName = await cli(fetcher, ["rename", "rename-validation"]);
  assert.equal(missingRenameName.exitCode, 1);
  assert.match(missingRenameName.stderr.error, /requires a new Project name/);
  await client.projects.remove("rename-validation");

  const overrideHttp = await http(fetcher, "POST", "/projects", { name: "x", runtimeKind: "docker" });
  assert.equal(overrideHttp.status, 400);
  await assert.rejects(client.projects.create({ name: "x", runtimeKind: "docker" }), (error) =>
    error.response.status === 400 && error.body.error === overrideHttp.body.error);

  const anonymousFetch = (url, init) => zv.fetch(new Request(url, init));
  const anonymousHttp = await anonymousFetch("http://localhost/zelavis/api/v1/runtime/projects");
  assert.ok([401, 403].includes(anonymousHttp.status));
  const anonymous = createZelavisClient({ baseUrl: "http://localhost", fetch: anonymousFetch });
  await assert.rejects(anonymous.projects.list(), (error) => error.response.status === anonymousHttp.status);
  assert.equal((await cli(anonymousFetch, ["list"])).stderr.status, anonymousHttp.status);

  await assert.rejects(client.projects.get(".."), /Invalid Project id/);
  const usage = await cli(fetcher, ["start"]);
  assert.equal(usage.exitCode, 1);
  assert.match(usage.stderr.error, /requires a Project id/);
});


test("package approval has HTTP, SDK and CLI parity and independent system authorization", async (t) => {
  const { createAuthorityKey } = await import("./fixtures/authority-keys.mjs");
  const key = await createAuthorityKey({ keyId: "package-test" });
  const submitted = [];
  const manifest = { id: "zelavis.packages-install", version: "v1", sha256: "a".repeat(64), interpreter: "/bin/sh", arguments: { set: { required: true, pattern: "^wordpress-stack$" } }, authorization: { permission: "server.packages.install", scope: "system" } };
  let fail = false;
  const agent = {
    hostOperationCatalog: async () => ({ agentId: "agent", operations: [manifest] }),
    submitHostOperation: async (request) => { submitted.push(request); return { ...request, agentId: "agent", status: fail ? "failed" : "succeeded", attempts: 1, events: [], createdAt: "", updatedAt: "" }; },
    getHostOperation: async () => undefined,
  };
  const broker = createHostOperationBroker({ agent, signer: { keyId: "package-test", privateKey: key.privateKey }, store: createMemorySystemStore() });
  const { zv, client, fetcher } = await boot(t, { broker });
  const denied = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "denied-packages", recipeName: "acme/packages", installHostPackages: true }) }), { principal: { id: "builder", type: "user", permissions: ["projects.create"] } });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /server.packages.install/);
  assert.equal(submitted.length, 0);
  await assert.rejects(client.projects.get("denied-packages"), (e) => e.status === 404);
  await client.projects.create({ name: "existing-packages", recipeName: "acme/packages" });
  assert.equal(submitted.length, 0, "approval is never inferred from recipe metadata or create permission");
  const created = await client.projects.create({ name: "sdk-packages", recipeName: "acme/packages", installHostPackages: true });
  assert.deepEqual(created.recipe.hostPackages, ["wordpress-stack"]);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].arguments, { set: "wordpress-stack" });
  assert.equal((await cli(fetcher, ["create", "cli-packages", "--recipe", "acme/packages", "--install-host-packages"])).exitCode, 0);
  assert.equal(submitted.length, 2);
  await assert.rejects(client.projects.create({ name: "invalid", recipeName: "acme/packages", installHostPackages: "yes" }), (e) => e.status === 400);
  assert.equal(submitted.length, 2);
  fail = true;
  await assert.rejects(client.projects.create({ name: "failed-packages", recipeName: "acme/packages", installHostPackages: true }), (e) => e.status === 502 && e.body.code === "HOST_PACKAGES_FAILED" && /^hostop_/.test(e.body.operationId));
  await assert.rejects(client.projects.get("failed-packages"), (e) => e.status === 404);
});


test("the same preview descriptor is read through HTTP, SDK and CLI", async (t) => {
  const edge = createZelavisEdgePreviews({ store: createMemorySystemStore(), host: createNodeEdgePreviewHost("127.0.0.1") });
  const { fetcher, client } = await boot(t, { edgePreviews: edge });
  const project = await client.projects.create({ id: "preview-site", name: "Preview", recipeName: "acme/plain" });
  assert.equal(project.preview.status, "ready");
  const httpRecord = await http(fetcher, "GET", "/projects/preview-site");
  const cliRecord = await cli(fetcher, ["get", "preview-site"]);
  assert.equal(cliRecord.exitCode, 0);
  assert.deepEqual(httpRecord.body.project.preview, project.preview);
  assert.deepEqual(cliRecord.stdout.project.preview, project.preview);
  await client.projects.stop(project.id);
  await assert.rejects(fetch(`http://127.0.0.1:${project.preview.port}`));
  assert.equal((await client.projects.start(project.id)).preview.port, project.preview.port);
  await client.projects.remove(project.id);
  await assert.rejects(fetch(`http://127.0.0.1:${project.preview.port}`));
});

test("install method and software version are offered, chosen and refused the same way on HTTP, SDK and CLI", async (t) => {
  const { fetcher, client } = await boot(t);

  const listed = await http(fetcher, "GET", "/project-recipes");
  const choosy = listed.body.projectRecipes.find((entry) => entry.name === "acme/choosy");
  assert.deepEqual(choosy.install, {
    methods: [{ id: "native", driver: "js", requires: [] }, { id: "container", driver: "oci", requires: ["docker"] }],
    software: [{ version: "7.1" }, { version: "6.9" }],
  }, "what can be chosen, without archive addresses or entry paths");
  assert.deepEqual((await client.projects.recipes()).find((entry) => entry.name === "acme/choosy").install, choosy.install);
  assert.deepEqual((await cli(fetcher, ["recipes"])).stdout.projectRecipes.find((entry) => entry.name === "acme/choosy").install, choosy.install);
  assert.equal(listed.body.projectRecipes.find((entry) => entry.name === "acme/plain").install, undefined);

  const viaHttp = await http(fetcher, "POST", "/projects", { name: "http-site", recipeName: "acme/choosy", softwareVersion: "6.9" });
  assert.equal(viaHttp.status, 201);
  const viaSdk = await client.projects.create({ name: "sdk-site", recipeName: "acme/choosy", softwareVersion: "6.9" });
  const viaCli = await cli(fetcher, ["create", "cli-site", "--recipe", "acme/choosy", "--software-version", "6.9"]);
  assert.equal(viaCli.exitCode, 0);
  assert.deepEqual(viaHttp.body.project.recipe.install, { method: "native", driver: "js", requires: [], software: "6.9" });
  assert.deepEqual(viaSdk.recipe.install, viaHttp.body.project.recipe.install);
  assert.deepEqual(viaCli.stdout.project.recipe.install, viaHttp.body.project.recipe.install);

  const newest = await client.projects.create({ name: "newest", recipeName: "acme/choosy" });
  assert.equal(newest.recipe.install.software, "7.1", "the newest when none is named");

  const refusedHttp = await http(fetcher, "POST", "/projects", { name: "bad-a", recipeName: "acme/choosy", method: "container" });
  assert.equal(refusedHttp.status, 400);
  assert.match(refusedHttp.body.error, /requested recipe method "container" is unavailable; no alternative was selected/);
  await assert.rejects(client.projects.create({ name: "bad-b", recipeName: "acme/choosy", method: "container" }), (error) =>
    error instanceof ZelavisClientHttpError && error.status === 400 && error.message === refusedHttp.body.error);
  const refusedCli = await cli(fetcher, ["create", "bad-c", "--recipe", "acme/choosy", "--method", "container"]);
  assert.notEqual(refusedCli.exitCode, 0);

  const wrongType = await http(fetcher, "POST", "/projects", { name: "bad-d", recipeName: "acme/choosy", method: 7 });
  assert.equal(wrongType.status, 400);
  const nothingToChoose = await http(fetcher, "POST", "/projects", { name: "bad-e", recipeName: "acme/plain", softwareVersion: "1.0" });
  assert.match(nothingToChoose.body.error, /no install method or software version to choose/);
  assert.equal((await http(fetcher, "GET", "/projects/bad-a")).status, 404, "a refused creation leaves nothing behind");

  const misplaced = await cli(fetcher, ["list", "--method", "native"]);
  assert.notEqual(misplaced.exitCode, 0);
  assert.match(JSON.stringify(misplaced.stderr), /only supported by projects create/);
});

test("setup values are listed without secrets, revealed only to who may, and every reveal is audited, the same on HTTP, SDK and CLI", async (t) => {
  const { zv, store, fetcher, client } = await boot(t);
  await client.projects.create({ id: "setup-site", name: "Setup", recipeName: "acme/plain" });
  const listed = await client.projects.setup("setup-site");
  assert.deepEqual(listed, [
    { id: "db-host", label: "Database host", secret: false, value: "127.0.0.1:3306/setup-site" },
    { id: "db-password", label: "Database password", secret: true },
  ]);
  assert.deepEqual((await http(fetcher, "GET", "/projects/setup-site/setup")).body.values, listed);
  assert.deepEqual((await cli(fetcher, ["setup", "setup-site"])).stdout.values, listed);
  assert.equal((await store.list("projects.setup-audit.v1")).length, 0, "listing reveals nothing and records nothing");

  const revealed = await client.projects.revealSetup("setup-site");
  assert.equal(revealed.find((value) => value.id === "db-password").value, "generated-secret");
  assert.deepEqual((await http(fetcher, "POST", "/projects/setup-site/setup/reveal")).body.values, revealed);
  assert.deepEqual((await cli(fetcher, ["setup", "setup-site", "--reveal"])).stdout.values, revealed);
  const trail = (await store.list("projects.setup-audit.v1")).map((record) => record.value);
  assert.equal(trail.length, 3, "one record per reveal");
  assert.ok(trail.every((entry) => entry.projectId === "setup-site" && entry.principalId === "owner" && entry.revealed.join() === "db-password"));
  assert.ok(!JSON.stringify(trail).includes("generated-secret"), "the secret itself is never recorded");

  // Viewing a Project is not authority to read its secrets.
  const viewer = { principal: { id: "viewer", type: "user", roles: [], permissions: [], grants: [{ permission: "project.view", scope: { type: "project", projectId: "setup-site" } }] } };
  const asViewer = (url, init) => zv.fetch(new Request(url, init), viewer);
  const base = "http://localhost/zelavis/api/v1/runtime/projects/setup-site/setup";
  assert.equal((await asViewer(base)).status, 200);
  assert.equal((await asViewer(`${base}/reveal`, { method: "POST" })).status, 403);
  assert.equal((await store.list("projects.setup-audit.v1")).length, 3, "a refused reveal records nothing");
});
