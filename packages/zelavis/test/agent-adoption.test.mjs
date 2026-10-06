import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentProcessClient,
  createAgentProcessServer,
} from "../dist/adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";

const closers = new Set();
const roots = new Set();
after(async () => {
  for (const close of closers) await close().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** The pid the Agent recorded for the only process it is running. */
async function runningPid(stateDirectory) {
  const { readdir, readFile } = await import("node:fs/promises");
  const names = await readdir(stateDirectory);
  for (const name of names) {
    const record = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
    if (alive(record.pid)) return record.pid;
  }
  throw new Error("no live process record");
}

const RECIPE = {
  name: "@zelavis/app",
  title: "Zelavis App",
  version: JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8")).version,
  runtimeKinds: ["native"],
  specifier: "@zelavis/app",
};

/** A prepared real App, including its frozen recipe and host descriptor. */
async function platformDirectory() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-adopt-"));
  roots.add(root);
  const projects = join(root, "projects");
  const project = { id: "sample", name: "Sample", kind: "zelavis", runtimeKind: "native", recipe: RECIPE };
  const driver = createNodeProcessProjectRuntime({ directory: projects });
  await driver.prepare(project, RECIPE);
  await driver.close();
  return { root, projects, project };
}

async function agentAt(root) {
  const directory = join(root, "agent");
  const runner = createLocalAgentProcessRunner({
    stateDirectory: join(root, "projects", ".agent-processes"),
    graceMs: 5000,
  });
  const server = await createAgentProcessServer({ directory, runner });
  closers.add(() => server.close());
  return directory;
}

async function client(directory) {
  const agent = await createAgentProcessClient({ directory });
  closers.add(() => agent.close());
  return agent;
}

test("a runner that cannot outlive the Platform says so", async () => {
  const local = createLocalAgentProcessRunner();
  // The flag is a property of where processes run, not of the driver that
  // asked for them — it was a hardcoded `false` in three drivers before.
  assert.equal(local.survivesControlPlaneRestart, false);
  assert.equal(local.attach, undefined);
});

for (const agedOut of [false, true]) test(`a real App is adopted and re-keyed without restart${agedOut ? " after its readiness replay is gone" : ""}`, async () => {
  const { root, projects, project } = await platformDirectory();
  const endpoint = await agentAt(root);
  const first = await client(endpoint);
  const original = createNodeProcessProjectRuntime({ directory: projects, agent: first });
  const started = await original.start(project);
  const pid = await runningPid(join(projects, ".agent-processes"));
  const claims = { projectId: "sample", scopeId: "platform", generation: 1, runtimeNodeId: "local", subject: "member", subjectType: "user", tenantId: "tenant", permissions: [] };
  const { ZELAVIS_GATEWAY_AUTHORITY_HEADER: header } = await import("../dist/platform/gateway-authority.js");
  const oldToken = await original.signGatewayAuthority("sample", claims);
  await first.close();
  assert.equal(alive(pid), true, "the separately supervised Agent keeps the App running");
  const second = await client(endpoint);
  const agent = !agedOut ? second : { ...second, attach: async id => (await second.attach(id)).map(value => ({ ...value, replay: [] })) };
  const driver = createNodeProcessProjectRuntime({ directory: projects, agent });
  assert.equal(driver.capabilities(project).survivesControlPlaneRestart, true);
  await driver.adopt();
  const adopted = await driver.status("sample");
  assert.equal(adopted.status, "running");
  assert.equal(adopted.url, started.url, "authenticated host re-keying reports the actual listener");
  assert.equal(await runningPid(join(projects, ".agent-processes")), pid);
  const denied = await fetch(`${adopted.url}/zelavis/api/v1/runtime/access`, { headers: { [header]: oldToken } });
  assert.equal(denied.status, 401); await denied.text();
  const token = await driver.signGatewayAuthority("sample", claims);
  const accepted = await fetch(`${adopted.url}/zelavis/api/v1/runtime/access`, { headers: { [header]: token } });
  assert.equal(accepted.status, 200); await accepted.text();
  assert.ok((await driver.logs("sample")).some(entry => /Re-attached/.test(entry.message)));
  assert.equal((await driver.stop("sample")).status, "stopped");
  await driver.close();
  await original.close();
});

test("adopting finds nothing when the Agent is running nothing", async () => {
  const { root, projects } = await platformDirectory();
  const endpoint = await agentAt(root);
  const agent = await client(endpoint);

  const driver = createNodeProcessProjectRuntime({
    directory: projects,
    agent,
  });
  await driver.adopt();

  assert.equal((await driver.status("sample")).status, "stopped");
});

test("a driver on the local runner adopts nothing and does not fail", async () => {
  const { projects } = await platformDirectory();
  const driver = createNodeProcessProjectRuntime({ directory: projects });

  // The local runner cannot attach. Adoption is always attempted and never
  // assumed, so this is a no-op rather than an error.
  await driver.adopt();
  assert.equal((await driver.status("sample")).status, "stopped");
  assert.equal(
    driver.capabilities({ id: "sample", kind: "zelavis", recipe: RECIPE })
      .survivesControlPlaneRestart,
    false,
  );
});


test("a Project the operator stopped is not left running by adoption", async () => {
  const { createProjectManager } = await import("../dist/project.js");
  const { createMemorySystemStore } = await import("../dist/system-store.js");

  // A driver that reports one Project as running — which is what adoption
  // produces — for a Project whose desired state is stopped.
  const stopped = [];
  const driver = {
    name: "adopted",
    capabilities: () => ({
      independentRuntimeVersion: false,
      movable: false,
      liveMigration: false,
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      statelessRuntimeReplicas: false,
      managedStorage: false,
      managedDatabase: false,
      databaseReplication: false,
      tenantPlacement: false,
      databaseSharding: false,
      runtimeOwnership: "platform-process",
      survivesControlPlaneRestart: true,
      description: "test",
    }),
    async prepare() {},
    async start() {
      return { status: "running", url: "http://127.0.0.1:1" };
    },
    async stop(projectId) {
      stopped.push(projectId);
      return { status: "stopped" };
    },
    async status(projectId) {
      return stopped.includes(projectId)
        ? { status: "stopped" }
        : { status: "running", url: "http://127.0.0.1:1" };
    },
    async logs() {
      return [];
    },
    async destroy() {},
    async close() {},
  };

  const store = createMemorySystemStore();
  const recipes = [
    {
      service: { name: "@zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} },
      specifier: "@zelavis/app",
      status: "available",
      source: "official",
      order: 0,
    },
  ];

  const setup = await createProjectManager({
    projectRecipes: recipes,
    store,
    runtime: driver,
    autoReconcile: false,
  });
  await setup.create({ id: "quiet", name: "quiet", start: false });
  await setup.close();

  const manager = await createProjectManager({
    projectRecipes: recipes,
    store,
    runtime: driver,
    autoReconcile: false,
  });
  await manager.reconcile();
  await manager.close();

  // Otherwise "stopped" would mean "stopped, unless it happened to survive a
  // crash" — the operator's intent silently undone by an implementation detail.
  assert.deepEqual(stopped, ["quiet"]);
});
