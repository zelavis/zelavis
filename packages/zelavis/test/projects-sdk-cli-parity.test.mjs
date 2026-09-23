import assert from "node:assert/strict";
import test from "node:test";

import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient, ZelavisClientHttpError } from "../dist/sdk/fetch.js";
import { runCli } from "../dist/cli/commands.js";

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
    async close() {},
  };
}

async function boot(t) {
  const runtime = projectRuntime();
  const zv = await zelavis({
    systemStore: createMemorySystemStore(),
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
        recipe("acme/plain"),
        recipe("acme/advised", { network: "advisory" }),
        recipe("acme/vm-only", { boundary: { minimum: "microvm", enforcement: "required" } }),
      ],
    },
  });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), OWNER);
  return {
    zv,
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
