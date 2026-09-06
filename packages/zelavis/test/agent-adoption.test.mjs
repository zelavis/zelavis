import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentProcessClient,
  createAgentProcessServer,
} from "../dist/adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";

const closers = new Set();
after(async () => {
  for (const close of closers) await close().catch(() => undefined);
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
  name: "zelavis/app",
  title: "Zelavis App",
  version: "1.0.0-test",
  specifier: "zelavis/app",
};

/**
 * A Project directory the Node driver will accept, with a runner it can start.
 *
 * The driver spawns its own runner module, so the Project is stood up by
 * writing what `prepare` writes and letting `start` do the rest — except the
 * runner here is a stub that performs the same readiness handshake the real one
 * does, because what is being tested is the handshake and the adoption, not the
 * Zelavis runtime.
 */
async function platformDirectory() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-adopt-"));
  const projects = join(root, "projects");
  await mkdir(join(projects, "sample"), { recursive: true });
  await writeFile(
    join(projects, "sample", "project.json"),
    JSON.stringify({ id: "sample", name: "sample", recipe: RECIPE }),
  );
  return { root, projects };
}

async function agentAt(root) {
  const directory = join(root, "agent");
  const runner = createLocalAgentProcessRunner({
    stateDirectory: join(root, "projects", ".agent-processes"),
    graceMs: 500,
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

test("a Project the Agent still runs is adopted, not restarted", async () => {
  const { root, projects } = await platformDirectory();
  const endpoint = await agentAt(root);

  // Stands in for the Zelavis runtime: announces the address it bound on
  // stdout, exactly as the real runner does, then keeps serving.
  const runnerModule = join(root, "fake-runner.mjs");
  await writeFile(
    runnerModule,
    `process.stdout.write(JSON.stringify({ type: "ready", url: "http://127.0.0.1:45001" }) + "\\n");
     setInterval(() => {}, 1000);`,
  );

  const first = await client(endpoint);
  const started = await first.start({
    workloadId: "sample",
    executable: process.execPath,
    args: [runnerModule],
    cwd: projects,
    env: { PATH: process.env.PATH ?? "" },
  });
  await new Promise((wait) => setTimeout(wait, 300));

  // The Platform disappears. The Agent keeps the Project serving.
  await first.close();
  await new Promise((wait) => setTimeout(wait, 200));

  // `running` is this client's view, and this client is gone — it reports what
  // it knows, which is nothing. The process itself is still there.
  assert.equal(started.running, false, "the disconnected client sees nothing");
  const pid = await runningPid(join(root, "projects", ".agent-processes"));
  assert.equal(alive(pid), true, "the Agent still holds it");

  // A new Platform composes: new client, new driver, same Agent.
  const second = await client(endpoint);
  const driver = createNodeProcessProjectRuntime({
    directory: projects,
    agent: second,
  });

  assert.equal(
    driver.capabilities({ id: "sample", kind: "zelavis", recipe: RECIPE })
      .survivesControlPlaneRestart,
    true,
    "the capability follows the Agent",
  );

  await driver.adopt();

  const snapshot = await driver.status("sample");
  // Restarting would drop the connections it is serving, and for a Project with
  // a persisted port would collide with the copy still listening.
  assert.equal(snapshot.status, "running");
  assert.equal(
    snapshot.url,
    "http://127.0.0.1:45001",
    "the address came from output written while no Platform was connected",
  );

  const logs = await driver.logs("sample");
  assert.ok(
    logs.some((entry) => /Re-attached to a running Project/.test(entry.message)),
    "the adoption is visible in the Project's own logs",
  );

  // And it is genuinely the Platform's again: stopping works through the
  // contract rather than needing the process killed.
  const stopped = await driver.stop("sample");
  assert.equal(stopped.status, "stopped");
  assert.equal(started.running, false);
});

test("adoption reports a Project whose readiness line has aged out honestly", async () => {
  const { root, projects } = await platformDirectory();
  const endpoint = await agentAt(root);

  // No readiness handshake at all: the same position a Platform is in when the
  // line has scrolled out of the Agent's bounded buffer.
  const runnerModule = join(root, "quiet-runner.mjs");
  await writeFile(runnerModule, `setInterval(() => {}, 1000);`);

  const first = await client(endpoint);
  await first.start({
    workloadId: "sample",
    executable: process.execPath,
    args: [runnerModule],
    cwd: projects,
    env: { PATH: process.env.PATH ?? "" },
  });
  await new Promise((wait) => setTimeout(wait, 200));
  await first.close();

  const second = await client(endpoint);
  const driver = createNodeProcessProjectRuntime({
    directory: projects,
    agent: second,
  });
  await driver.adopt();

  const snapshot = await driver.status("sample");
  assert.equal(snapshot.status, "running");
  // No address invented. A Project routed to a guessed URL is worse than one
  // the Platform admits it cannot route.
  assert.equal(snapshot.url, undefined);
  const logs = await driver.logs("sample");
  assert.ok(
    logs.some((entry) => /no longer in the Agent's buffer/.test(entry.message)),
    "the gap is stated rather than papered over",
  );

  await driver.stop("sample");
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
      service: { name: "zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} },
      specifier: "zelavis/app",
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
