import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Zelavis,
  ZelavisProjectDeletionError,
  createAssistantManager,
  createDeploymentBackendManager,
  createDeploymentBackendProjectRuntime,
  createMemorySystemStore,
  createProjectManager,
} from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createLocalFileStorage } from "../dist/adapters/_shared.js";
import { formatProjectProcessExitError } from "../dist/adapters/_node-project-runtime.js";

const PLATFORM_OWNER_CONTEXT = {
  principal: { id: "test-owner", type: "user", roles: ["owner"], permissions: ["*"] },
};

const TEST_BACKEND_CAPABILITIES = {
  isolationBoundary: "process",
  filesystemIsolation: "planned",
  processIsolation: "planned",
  networkIsolation: "planned",
  resourceLimits: "planned",
  exec: "available",
  persistentStorage: "available",
  snapshots: "planned",
  images: "unavailable",
  description: "Test deployment backend",
};

test("deployment backend policy is durable and remains separate from Project assignment", async () => {
  const store = createMemorySystemStore();
  const detected = [];
  const backends = ["native", "docker"].map((id) => ({
    id,
    title: id,
    capabilities: TEST_BACKEND_CAPABILITIES,
    projectRuntime: { name: `${id}-test-runtime` },
    async detect() {
      detected.push(id);
      return {
        state: "ready",
        installed: true,
        healthy: true,
        checkedAt: new Date().toISOString(),
      };
    },
  }));
  const manager = createDeploymentBackendManager({
    store,
    backends,
  });

  assert.deepEqual(await manager.getPolicy(), {
    defaultBackend: "native",
    enabledBackends: ["native"],
    updatedAt: (await manager.getPolicy()).updatedAt,
  });
  await manager.enable("docker");
  await manager.setDefault("docker");
  const durablePolicy = await manager.getPolicy();
  assert.equal(durablePolicy.defaultBackend, "docker");
  assert.deepEqual(durablePolicy.enabledBackends, ["native", "docker"]);
  assert.deepEqual(detected, ["docker", "docker"]);

  const restored = createDeploymentBackendManager({
    store,
    backends,
  });
  assert.equal((await restored.getPolicy()).defaultBackend, "docker");
});

test("Platform exposes only read access to the connected Agent journal", async () => {
  const operation = {
    operationId: "operation-id-0000003",
    agentId: "agent-a",
    operation: "native.preflight",
    version: "v1",
    artifactDigest: "a".repeat(64),
    status: "queued",
    attempts: 0,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    events: [],
  };
  const zv = new Zelavis({
    agentOperations: {
      identity: { id: "agent-a", createdAt: "2026-08-31T00:00:00.000Z" },
      async get(id) {
        return id === operation.operationId ? operation : undefined;
      },
      async list() {
        return [operation];
      },
    },
  });
  try {
    const runtime = await zv.runtime();
    const response = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/agent"),
      PLATFORM_OWNER_CONTEXT,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.identity.id, "agent-a");
    assert.equal(body.operations[0].operationId, operation.operationId);
    assert.equal("authority" in body.operations[0], false);
    assert.ok(!runtime.routes.some((route) =>
      route.route.path === "/agent/operations" && route.route.method === "POST"
    ));
  } finally {
    await zv.close();
  }
});

test("deployment backend runtime registry dispatches from the stored Project assignment", async () => {
  const store = createMemorySystemStore();
  const calls = [];
  const driver = (id) => ({
    name: `${id}-driver`,
    runtimeKinds: [id],
    capabilities: () => ({ secureIsolation: id === "docker" }),
    async prepare(project) { calls.push(`${id}:prepare:${project.id}`); },
    async start(project) {
      calls.push(`${id}:start:${project.id}`);
      return { status: "running", url: `http://${id}.internal` };
    },
    async stop(projectId) {
      calls.push(`${id}:stop:${projectId}`);
      return { status: "stopped" };
    },
    async status() { return { status: "stopped" }; },
    async logs() { return []; },
    async destroy() {},
    async close() {},
  });
  const native = driver("native");
  const docker = driver("docker");
  const runtime = createDeploymentBackendProjectRuntime({
    store,
    backends: [
      { id: "native", title: "Native", capabilities: TEST_BACKEND_CAPABILITIES, projectRuntime: native, detect: async () => ({}) },
      { id: "docker", title: "Docker", capabilities: TEST_BACKEND_CAPABILITIES, projectRuntime: docker, detect: async () => ({}) },
    ],
  });
  assert.deepEqual(runtime.runtimeKinds, ["native", "docker"]);
  const project = {
    id: "site-a",
    name: "Site A",
    kind: "wordpress",
    runtimeKind: "docker",
    recipe: {
      name: "zelavis/wordpress",
      title: "WordPress",
      version: "1.0.0",
      specifier: "zelavis/wordpress",
      runtimeKinds: ["native", "docker"],
    },
  };
  await store.set("projects", project.id, project);
  assert.equal((await runtime.start(project)).url, "http://docker.internal");
  await runtime.stop(project.id);
  assert.deepEqual(calls, ["docker:start:site-a", "docker:stop:site-a"]);
});

test("project process failures include the useful stderr cause", () => {
  assert.equal(
    formatProjectProcessExitError({
      code: 1,
      signal: null,
      logs: [
        {
          timestamp: "2026-08-28T10:04:42.694Z",
          stream: "stderr",
          message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-app'",
        },
        {
          timestamp: "2026-08-28T10:04:42.694Z",
          stream: "stderr",
          message: "    at moduleResolve (node:internal/modules/esm/resolve:873:18)",
        },
      ],
    }),
    "Project process exited with code 1. Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-app' See project logs for full output.",
  );
});

test("local file storage cannot escape its configured root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-files-"));
  const storage = createLocalFileStorage(join(directory, "root"));
  try {
    await assert.rejects(
      storage.put({ path: "../outside.txt", body: "forbidden" }),
      /escapes storage root/,
    );
    await assert.rejects(
      storage.get("assets/../../outside.txt"),
      /escapes storage root/,
    );
    const stored = await storage.put({
      path: "assets/file..min.js",
      body: "allowed",
    });
    assert.equal(stored.path, "assets/file..min.js");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("System Store keeps platform records outside project database APIs", async () => {
  const store = createMemorySystemStore();
  await store.set("dashboard", "settings", { theme: "dark" });

  assert.deepEqual((await store.get("dashboard", "settings"))?.value, {
    theme: "dark",
  });
  assert.deepEqual(await store.list("dashboard"), [
    {
      namespace: "dashboard",
      key: "settings",
      value: { theme: "dark" },
      updatedAt: (await store.get("dashboard", "settings")).updatedAt,
    },
  ]);
  assert.equal(await store.delete("dashboard", "settings"), true);
  assert.equal(await store.get("dashboard", "settings"), undefined);
});

test("Assistant manager persists project-scoped threads and responder actions", async () => {
  const store = createMemorySystemStore();
  const assistant = createAssistantManager({ store });
  const created = await assistant.create({ projectId: "project-a" });
  const result = await assistant.appendMessage(created.id, "Open the database");

  assert.equal(result.thread.title, "Open the database");
  assert.equal(result.thread.messages.length, 2);
  assert.deepEqual(result.assistantMessage.actions, [
    { label: "Open Database", to: "/projects/project-a/database" },
  ]);
  assert.equal((await assistant.list("project-a"))[0].id, created.id);
  assert.equal((await assistant.get(created.id)).messages.length, 2);
});

test("Assistant capability is available through versioned runtime endpoints", async () => {
  const zv = new Zelavis();
  const createResponse = await zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/assistant/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-a" }),
    }),
    PLATFORM_OWNER_CONTEXT,
  );
  const created = await createResponse.json();

  assert.equal(createResponse.status, 201);
  const messageResponse = await zv.fetch(
    new Request(
      `http://localhost/zelavis/api/v1/runtime/assistant/threads/${created.thread.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "Show resources" }),
      },
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const message = await messageResponse.json();
  assert.equal(messageResponse.status, 201);
  assert.equal(message.assistantMessage.actions[0].to, "/resources");

  const listResponse = await zv.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/assistant/threads?projectId=project-a",
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const listed = await listResponse.json();
  assert.equal(listed.responder, "zelavis-local-router");
  assert.equal(listed.threads[0].id, created.thread.id);
});

test("Zelavis accepts a custom Assistant responder at the public entrypoint", async () => {
  const zv = new Zelavis({
    assistant: {
      name: "test-responder",
      respond: ({ prompt }) => ({ content: `Received: ${prompt}` }),
    },
  });
  const created = await (
    await zv.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/assistant/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      PLATFORM_OWNER_CONTEXT,
    )
  ).json();
  const response = await zv.fetch(
    new Request(
      `http://localhost/zelavis/api/v1/runtime/assistant/threads/${created.thread.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      },
    ),
    PLATFORM_OWNER_CONTEXT,
  );
  const result = await response.json();
  assert.equal(result.assistantMessage.content, "Received: hello");
});

test("Node adapter registers shipped Project recipes and persists Platform Store SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-platform-"));

  try {
    const firstAdapter = nodeAdapter({ dataDirectory: directory });
    const first = await firstAdapter.resolve({});
    const systemStore = first.resources?.systemStore;
    const appService = first.serviceRegistry?.catalog?.find(
      (entry) => entry.service.name === "zelavis/app",
    );
    const wordpressService = first.serviceRegistry?.catalog?.find(
      (entry) => entry.service.name === "zelavis/wordpress",
    );

    assert.ok(systemStore);
    assert.equal(first.coreServices.database, false);
    // The frontend service stays enabled on the Platform: with the dashboard
    // running it makes `/` lead there rather than returning a 404.
    assert.equal(first.coreServices.website, undefined);
    assert.equal(first.coreServices.storage, false);
    assert.equal(first.coreServices.workloads, false);
    assert.equal(first.metadata.role, "platform");
    assert.equal(appService?.service.kind, "app");
    assert.equal(appService?.source, "official");
    assert.equal(wordpressService?.service.kind, "app");
    assert.equal(wordpressService?.service.marketplace?.title, "WordPress");
    assert.equal(wordpressService?.source, "official");
    await systemStore.set("platform", "marker", { ready: true });

    const second = await nodeAdapter({ dataDirectory: directory }).resolve({});
    assert.deepEqual(
      (await second.resources.systemStore.get("platform", "marker"))?.value,
      { ready: true },
    );

    const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });
    const runtime = await zv.runtime();
    const response = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/project-recipes"),
      PLATFORM_OWNER_CONTEXT,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.projectRecipes[0].name, "zelavis/app");
    assert.equal(body.projectRecipes[0].source, "official");
    assert.deepEqual(body.projectRecipes[0].runtimeKinds, ["native"]);
    assert.deepEqual(
      body.projectRecipes.map((recipe) => recipe.name),
      ["zelavis/app", "zelavis/wordpress"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Project manager preserves an older Zelavis App release lock when the Platform is newer", async () => {
  const store = createMemorySystemStore();
  const prepared = new Set();
  const appService = {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "test-runtime",
    capabilities: () => ({
      independentRuntimeVersion: true,
      movable: false,
      liveMigration: false,
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      statelessRuntimeReplicas: false,
      managedStorage: true,
      managedDatabase: true,
      databaseReplication: false,
      tenantPlacement: false,
      databaseSharding: false,
      runtimeOwnership: "platform-process",
      survivesControlPlaneRestart: false,
      description: "Test runtime",
    }),
    async prepare(project, app) {
      assert.equal(project.id, "older-app");
      assert.equal(app.name, "zelavis/app");
      assert.equal(app.specifier, "zelavis/app");
      assert.equal(app.version, "0.9.0");
      prepared.add(project.id);
    },
    async start(project) {
      assert.equal(prepared.has(project.id), true);
      return {
        status: "running",
        url: "http://127.0.0.1:49152",
        startedAt: new Date().toISOString(),
      };
    },
    async stop() {
      return { status: "stopped", stoppedAt: new Date().toISOString() };
    },
    async status() {
      return { status: "stopped" };
    },
    async logs() {
      return [];
    },
    async destroy() {},
    async close() {},
  };

  await store.set("projects", "older-app", {
    id: "older-app",
    name: "Older App",
    kind: "zelavis",
    app: {
      name: "zelavis/app",
      title: "Zelavis App",
      version: "0.9.0",
      specifier: "zelavis/app",
    },
    desiredState: "stopped",
    runtime: {
      driver: "test-runtime",
      status: "failed",
      error: "Project process exited with code 1.",
    },
    createdAt: "2026-08-23T08:15:14.633Z",
    updatedAt: "2026-08-23T08:15:14.633Z",
  });

  const manager = await createProjectManager({
    store,
    projectRecipes: [appService],
    runtime,
  });
  const project = await manager.start("older-app");
  const stored = (await store.get("projects", "older-app")).value;

  assert.equal(project.runtime.status, "running");
  assert.equal(stored.recipe.name, "zelavis/app");
  assert.equal(stored.recipe.specifier, "zelavis/app");
  assert.equal(stored.recipe.version, "0.9.0");
  assert.deepEqual(stored.recipe.runtimeKinds, ["native"]);
  assert.equal(stored.app, undefined);
  assert.equal(stored.runtimeKind, "native");
});

test("Project manager repairs the retired official App package lock without changing its version", async () => {
  const store = createMemorySystemStore();
  let preparedRecipe;
  const appService = {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "repair-runtime",
    capabilities: () => ({
      independentRuntimeVersion: false,
      movable: false,
      liveMigration: false,
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      statelessRuntimeReplicas: false,
      managedStorage: true,
      managedDatabase: true,
      databaseReplication: false,
      tenantPlacement: false,
      databaseSharding: false,
      runtimeOwnership: "platform-process",
      survivesControlPlaneRestart: false,
      description: "Repair test runtime",
    }),
    async prepare(_project, recipe) {
      preparedRecipe = recipe;
    },
    async start() {
      return { status: "running", url: "http://127.0.0.1:49152" };
    },
    async stop() {
      return { status: "stopped" };
    },
    async status() {
      return { status: "stopped" };
    },
    async logs() {
      return [];
    },
    async destroy() {},
    async close() {},
  };

  await store.set("projects", "legacy-app", {
    id: "legacy-app",
    name: "Legacy App",
    kind: "zelavis",
    app: {
      name: "@zelavis/app",
      title: "Zelavis App",
      version: "0.9.0",
      specifier: "@zelavis/app",
    },
    desiredState: "stopped",
    runtime: { driver: "repair-runtime", status: "failed" },
    createdAt: "2026-08-23T08:15:14.633Z",
    updatedAt: "2026-08-23T08:15:14.633Z",
  });

  const manager = await createProjectManager({
    store,
    projectRecipes: [appService],
    runtime,
  });
  const project = await manager.start("legacy-app");

  assert.deepEqual(project.recipe, {
    name: "zelavis/app",
    title: "Zelavis App",
    version: "0.9.0",
    specifier: "zelavis/app",
    runtimeKinds: ["native"],
  });
  assert.deepEqual(preparedRecipe, project.recipe);
  assert.deepEqual((await store.get("projects", "legacy-app")).value.recipe, project.recipe);
  assert.equal((await store.get("projects", "legacy-app")).value.app, undefined);
});

test("Project startup reconciliation is bounded and closes through the runtime driver", async () => {
  const store = createMemorySystemStore();
  const starts = [];
  const running = new Set();
  let activeStarts = 0;
  let maxActiveStarts = 0;
  let closeCalls = 0;
  const appService = {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "bounded-runtime",
    startupConcurrency: 1,
    capabilities: () => ({
      independentRuntimeVersion: false,
      movable: false,
      liveMigration: false,
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      statelessRuntimeReplicas: false,
      managedStorage: true,
      managedDatabase: true,
      databaseReplication: false,
      tenantPlacement: false,
      databaseSharding: false,
      runtimeOwnership: "platform-process",
      survivesControlPlaneRestart: false,
      description: "Bounded test runtime",
    }),
    async prepare() {},
    async start(project) {
      starts.push(project.id);
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      activeStarts -= 1;
      running.add(project.id);
      return {
        status: "running",
        url: `http://127.0.0.1/${project.id}`,
      };
    },
    async stop() {
      return { status: "stopped" };
    },
    async status(projectId) {
      return running.has(projectId)
        ? { status: "running", url: `http://127.0.0.1/${projectId}` }
        : { status: "stopped" };
    },
    async logs() {
      return [];
    },
    async destroy() {},
    async close() {
      closeCalls += 1;
    },
  };

  for (const id of ["alpha", "beta", "gamma"]) {
    await store.set("projects", id, {
      id,
      name: id,
      kind: "zelavis",
      recipe: {
        name: "zelavis/app",
        title: "Zelavis App",
        version: "1.0.1-alpha.2",
        specifier: "zelavis/app",
      },
      desiredState: "running",
      runtime: { driver: runtime.name, status: "stopped" },
      createdAt: "2026-08-23T08:15:14.633Z",
      updatedAt: "2026-08-23T08:15:14.633Z",
    });
  }

  const manager = await createProjectManager({
    store,
    projectRecipes: [appService],
    runtime,
  });
  await manager.reconcile();
  await manager.close();
  await manager.close();

  assert.deepEqual(starts, ["alpha", "beta", "gamma"]);
  assert.equal(maxActiveStarts, 1);
  assert.equal(closeCalls, 1);
});

test("Project deletion persists progress and resumes unfinished cleanup after restart", async () => {
  const store = createMemorySystemStore();
  const cleanupCalls = [];
  let failCleanup = true;
  let destroyCalls = 0;
  const appService = {
    service: {
      name: "zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "deletion-runtime",
    startupConcurrency: 1,
    capabilities: () => ({
      independentRuntimeVersion: false,
      movable: false,
      liveMigration: false,
      secureIsolation: false,
      resourceLimits: false,
      persistentFilesystem: true,
      statelessRuntimeReplicas: false,
      managedStorage: true,
      managedDatabase: true,
      databaseReplication: false,
      tenantPlacement: false,
      databaseSharding: false,
      runtimeOwnership: "platform-process",
      survivesControlPlaneRestart: false,
      description: "Deletion test runtime",
    }),
    async prepare() {},
    async start() {
      return { status: "running", url: "http://127.0.0.1:49152" };
    },
    async stop() {
      return { status: "stopped", stoppedAt: new Date().toISOString() };
    },
    async status() {
      return { status: "stopped" };
    },
    async logs() {
      return [];
    },
    async destroy() {
      destroyCalls += 1;
    },
    async close() {},
  };
  const cleanupParticipants = [
    {
      id: "first-resource",
      async cleanup() {
        cleanupCalls.push("first-resource");
      },
    },
    {
      id: "flaky-resource",
      async cleanup() {
        cleanupCalls.push("flaky-resource");
        if (failCleanup) {
          failCleanup = false;
          throw new Error("temporary cleanup outage");
        }
      },
    },
  ];

  const first = await createProjectManager({
    store,
    projectRecipes: [appService],
    runtime,
    cleanupParticipants,
  });
  await first.create({ id: "delete-me", name: "Delete Me", start: false });
  await assert.rejects(
    first.remove("delete-me"),
    (error) =>
      error instanceof ZelavisProjectDeletionError &&
      error.participantId === "flaky-resource",
  );

  const tombstone = (await store.get("projects", "delete-me")).value;
  assert.equal(tombstone.deletion.status, "failed");
  assert.equal(tombstone.deletion.currentParticipant, "flaky-resource");
  // `owned-projects` runs first: a Project's own runtime data must outlive the
  // runtimes that belong to it, and an owned runtime is only removable while
  // its owner still exists to describe it.
  assert.deepEqual(tombstone.deletion.completedParticipants, [
    "owned-projects",
    "first-resource",
  ]);
  assert.deepEqual(tombstone.deletion.participants, [
    "owned-projects",
    "first-resource",
    "flaky-resource",
    "runtime-data",
  ]);
  await assert.rejects(first.start("delete-me"), /pending deletion/);
  await first.close();

  const resumed = await createProjectManager({
    store,
    projectRecipes: [appService],
    runtime,
    cleanupParticipants,
  });
  await resumed.reconcile();

  assert.equal(await store.get("projects", "delete-me"), undefined);
  assert.deepEqual(cleanupCalls, [
    "first-resource",
    "flaky-resource",
    "flaky-resource",
  ]);
  assert.equal(destroyCalls, 1);
  await resumed.close();
});

test("Node adapter creates independently persisted Zelavis App runtimes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-projects-"));
  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: directory }),
  });
  const runtimeRequest = (path, init) =>
    zv.fetch(
      new Request(`http://localhost/zelavis/api/v1/runtime${path}`, init),
      PLATFORM_OWNER_CONTEXT,
    );
  const projectRuntimeUrls = new Map();

  try {
    const unsupportedDockerResponse = await runtimeRequest("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "docker-is-not-enabled",
        name: "Docker Is Not Enabled",
        recipeName: "zelavis/app",
        runtimeKind: "docker",
      }),
    });
    const unsupportedDockerBody = await unsupportedDockerResponse.json();
    assert.equal(unsupportedDockerResponse.status, 400);
    assert.match(unsupportedDockerBody.error, /selected by server policy/);

    const deploymentBackendsResponse = await runtimeRequest("/deployment-backends");
    const deploymentBackendsBody = await deploymentBackendsResponse.json();
    assert.equal(deploymentBackendsResponse.status, 200);
    assert.equal(deploymentBackendsBody.policy.defaultBackend, "native");
    assert.deepEqual(deploymentBackendsBody.policy.enabledBackends, ["native"]);
    assert.equal(
      deploymentBackendsBody.backends.find((backend) => backend.id === "native")?.executable,
      true,
    );
    assert.equal(
      deploymentBackendsBody.backends.find((backend) => backend.id === "docker")?.executable,
      false,
    );

    for (const [id, name] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]) {
      const response = await runtimeRequest("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name, recipeName: "zelavis/app" }),
      });
      const body = await response.json();

      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.project.recipe.name, "zelavis/app");
      assert.equal(body.project.runtime.status, "running");
      assert.match(body.project.runtime.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      projectRuntimeUrls.set(id, body.project.runtime.url);
    }

    const projectConfigResponse = await runtimeRequest(
      "/projects/alpha/proxy/zelavis/api/v1/runtime/config",
    );
    assert.equal(projectConfigResponse.status, 200);
    const projectConfig = await projectConfigResponse.json();
    assert.ok(
      !projectConfig.services.some((service) => service.name === "@zelavis/ui"),
    );
    assert.equal(
      projectConfig.services.find((service) => service.name === "@zelavis/db")
        ?.menu?.title,
      "Database",
    );
    assert.equal(
      projectConfig.services.find(
        (service) => service.name === "@zelavis/workloads",
      )?.menu?.title,
      "Workloads",
    );

    const proxiedAccounts = await runtimeRequest(
      "/projects/alpha/proxy/zelavis/api/v1/auth/accounts",
    );
    assert.equal(proxiedAccounts.status, 200, await proxiedAccounts.text());
    const directAccounts = await fetch(
      `${projectRuntimeUrls.get("alpha")}/zelavis/api/v1/auth/accounts`,
    );
    assert.equal(directAccounts.status, 401);

    const childDashboardResponse = await fetch(`${projectRuntimeUrls.get("alpha")}/zelavis`);
    const childDashboardBody = await childDashboardResponse.text();
    assert.doesNotMatch(childDashboardBody, /Zelavis Dashboard/);
    assert.doesNotMatch(childDashboardBody, /__ZELAVIS_RUNTIME_CONFIG__/);

    const updateSettingsResponse = await runtimeRequest(
      "/projects/alpha/proxy/zelavis/api/v1/runtime/settings",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: "dark" }),
      },
    );
    assert.equal(updateSettingsResponse.status, 200);
    await runtimeRequest("/projects/alpha/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await runtimeRequest("/projects/alpha/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const restartResponse = await runtimeRequest("/projects/alpha/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const restartedProject = (await restartResponse.json()).project;
    assert.equal(restartResponse.status, 200);
    assert.equal(restartedProject.runtime.status, "running");
    const persistedSettings = await (
      await runtimeRequest(
        "/projects/alpha/proxy/zelavis/api/v1/runtime/settings",
      )
    ).json();
    assert.equal(persistedSettings.theme, "dark");

    const createCollection = await runtimeRequest(
      "/projects/alpha/proxy/zelavis/api/v1/database/documents/collections",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenantId: "zelavis-app",
          name: "alpha_only",
          surface: "database",
        }),
      },
    );
    assert.equal(createCollection.status, 201, await createCollection.text());

    const alphaCollections = await (
      await runtimeRequest(
        "/projects/alpha/proxy/zelavis/api/v1/database/documents/collections?tenantId=zelavis-app",
      )
    ).json();
    const betaCollections = await (
      await runtimeRequest(
        "/projects/beta/proxy/zelavis/api/v1/database/documents/collections?tenantId=zelavis-app",
      )
    ).json();
    assert.ok(
      alphaCollections.collections.some(
        (collection) => collection.name === "alpha_only",
      ),
    );
    assert.ok(
      !betaCollections.collections.some(
        (collection) => collection.name === "alpha_only",
      ),
    );
    const dataRestartResponse = await runtimeRequest("/projects/alpha/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(dataRestartResponse.status, 200);
    const collectionsAfterRestart = await (
      await runtimeRequest(
        "/projects/alpha/proxy/zelavis/api/v1/database/documents/collections?tenantId=zelavis-app",
      )
    ).json();
    assert.ok(
      collectionsAfterRestart.collections.some(
        (collection) => collection.name === "alpha_only",
      ),
    );
    await assert.rejects(access(join(directory, "zelavis.sqlite")), {
      code: "ENOENT",
    });
    await assert.rejects(
      access(join(directory, "projects", "alpha", ".zelavis", "zelavis.sqlite")),
      { code: "ENOENT" },
    );
    await Promise.all(
      ["pshard-0001", "pshard-0002", "pshard-0003", "pshard-0004"].map(
        (shardId) =>
          access(
            join(
              directory,
              "projects",
              "alpha",
              ".zelavis",
              "data",
              "primary",
              "shards",
              `${shardId}.sqlite`,
            ),
          ),
      ),
    );
    await access(
      join(
        directory,
        "projects",
        "alpha",
        ".zelavis",
        "runtime",
        "zelavis.sqlite",
      ),
    );
    await assert.rejects(
      access(
        join(
          directory,
          "projects",
          "alpha",
          ".zelavis",
          "system",
          "zelavis.sqlite",
        ),
      ),
      { code: "ENOENT" },
    );

    const listResponse = await runtimeRequest("/projects");
    const listBody = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.runtime.driver, "deployment-backends");
    assert.deepEqual(listBody.runtime.availableKinds, ["native"]);
    assert.equal(listBody.projects[0].runtimeKind, "native");
    assert.equal(listBody.projects[0].capabilities.secureIsolation, false);
    assert.equal(listBody.projects[0].capabilities.movable, false);
    assert.equal(listBody.projects[0].capabilities.managedDatabase, true);
    assert.equal(
      listBody.projects[0].capabilities.survivesControlPlaneRestart,
      false,
    );
    assert.equal(listBody.projects.length, 2);

    const fabricResponse = await zv.plain({
      url: "/zelavis/api/v1/fabric/placements/projects/beta",
      principal: { id: "owner", type: "system", permissions: ["fabric.view"] },
    });
    const fabricBody = fabricResponse.body;
    assert.equal(fabricResponse.status, 200);
    assert.deepEqual(fabricBody.placement.identity, {
      scopeId: "local-platform",
      workloadId: "beta",
      type: "project",
    });
    assert.equal(fabricBody.placement.runtimeNodeId, "local");
    assert.equal(fabricBody.placement.databaseNodeId, "local");
    assert.equal(fabricBody.placement.generation, 1);

    const assistantThreadResponse = await zv.fetch(
      new Request(
        "http://localhost/zelavis/api/v1/runtime/assistant/threads",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "alpha" }),
        },
      ),
      PLATFORM_OWNER_CONTEXT,
    );
    assert.equal(assistantThreadResponse.status, 201);
    const files = zv.platform.resources.files;
    assert.ok(files);
    await files.put({
      path: "apps/alpha/@example/demo/dist/index.js",
      body: "console.log('alpha')",
      contentType: "text/javascript; charset=utf-8",
    });

    const deleteResponse = await runtimeRequest("/projects/alpha", {
      method: "DELETE",
    });
    const deleteBody = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
    assert.deepEqual(deleteBody, { deleted: true });
    await assert.rejects(access(join(directory, "projects", "alpha")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(directory, "files", "apps", "alpha")), {
      code: "ENOENT",
    });
    const assistantThreadsAfterDelete = await (
      await zv.fetch(
        new Request(
          "http://localhost/zelavis/api/v1/runtime/assistant/threads?projectId=alpha",
        ),
        PLATFORM_OWNER_CONTEXT,
      )
    ).json();
    assert.deepEqual(assistantThreadsAfterDelete.threads, []);

    const afterDeleteResponse = await runtimeRequest("/projects");
    const afterDeleteBody = await afterDeleteResponse.json();
    assert.equal(afterDeleteResponse.status, 200);
    assert.deepEqual(
      afterDeleteBody.projects.map((project) => project.id),
      ["beta"],
    );

    const deletedProjectResponse = await runtimeRequest("/projects/alpha");
    assert.equal(deletedProjectResponse.status, 404);
  } finally {
    await zv.close();
    await zv.close();
    const betaRuntimeUrl = projectRuntimeUrls.get("beta");
    if (betaRuntimeUrl) {
      await assert.rejects(fetch(`${betaRuntimeUrl}/zelavis`));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
