import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Zelavis,
  createAssistantManager,
  createMemorySystemStore,
  createProjectManager,
} from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";

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
  );
  const message = await messageResponse.json();
  assert.equal(messageResponse.status, 201);
  assert.equal(message.assistantMessage.actions[0].to, "/resources");

  const listResponse = await zv.fetch(
    new Request(
      "http://localhost/zelavis/api/v1/runtime/assistant/threads?projectId=project-a",
    ),
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
  );
  const result = await response.json();
  assert.equal(result.assistantMessage.content, "Received: hello");
});

test("Node adapter registers shipped app services and persists Platform Store SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-platform-"));

  try {
    const firstAdapter = nodeAdapter({ dataDirectory: directory });
    const first = await firstAdapter.resolve({});
    const systemStore = first.resources?.systemStore;
    const appService = first.serviceRegistry?.catalog?.find(
      (entry) => entry.service.name === "@zelavis/app",
    );

    assert.ok(systemStore);
    assert.equal(first.coreServices.database, false);
    assert.equal(first.coreServices.website, false);
    assert.equal(first.coreServices.storage, false);
    assert.equal(first.coreServices.workloads, false);
    assert.equal(first.metadata.role, "platform");
    assert.equal(appService?.service.kind, "app");
    assert.equal(appService?.source, "official");
    await systemStore.set("platform", "marker", { ready: true });

    const second = await nodeAdapter({ dataDirectory: directory }).resolve({});
    assert.deepEqual(
      (await second.resources.systemStore.get("platform", "marker"))?.value,
      { ready: true },
    );

    const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });
    const runtime = await zv.runtime();
    const response = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/app-services"),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.appServices[0].name, "@zelavis/app");
    assert.equal(body.appServices[0].source, "official");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Project manager repairs legacy blueprint project records before start", async () => {
  const store = createMemorySystemStore();
  const prepared = new Set();
  const appService = {
    service: {
      name: "@zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "@zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "test-runtime",
    capabilities: () => ({
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
      assert.equal(project.id, "legacy");
      assert.equal(app.name, "@zelavis/app");
      assert.equal(app.specifier, "@zelavis/app");
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

  await store.set("projects", "legacy", {
    id: "legacy",
    name: "Legacy",
    kind: "zelavis",
    blueprint: {
      id: "zelavis/app",
      version: "1.0.1-alpha.2",
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
    appServices: [appService],
    runtime,
  });
  const project = await manager.start("legacy");
  const stored = (await store.get("projects", "legacy")).value;

  assert.equal(project.runtime.status, "running");
  assert.equal(stored.app.name, "@zelavis/app");
  assert.equal(stored.app.specifier, "@zelavis/app");
  assert.equal("blueprint" in stored, false);
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
      name: "@zelavis/app",
      kind: "app",
      version: "1.0.1-alpha.2",
      marketplace: { title: "Zelavis App" },
    },
    specifier: "@zelavis/app",
    status: "installed",
    source: "official",
  };
  const runtime = {
    name: "bounded-runtime",
    startupConcurrency: 1,
    capabilities: () => ({
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
      app: {
        name: "@zelavis/app",
        title: "Zelavis App",
        version: "1.0.1-alpha.2",
        specifier: "@zelavis/app",
      },
      desiredState: "running",
      runtime: { driver: runtime.name, status: "stopped" },
      createdAt: "2026-08-23T08:15:14.633Z",
      updatedAt: "2026-08-23T08:15:14.633Z",
    });
  }

  const manager = await createProjectManager({
    store,
    appServices: [appService],
    runtime,
  });
  await manager.reconcile();
  await manager.close();
  await manager.close();

  assert.deepEqual(starts, ["alpha", "beta", "gamma"]);
  assert.equal(maxActiveStarts, 1);
  assert.equal(closeCalls, 1);
});

test("Node adapter creates independently persisted Zelavis App runtimes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-projects-"));
  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: directory }),
  });
  const runtimeRequest = (path, init) =>
    zv.fetch(
      new Request(`http://localhost/zelavis/api/v1/runtime${path}`, init),
    );
  const projectRuntimeUrls = new Map();

  try {
    for (const [id, name] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]) {
      const response = await runtimeRequest("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name, appServiceName: "@zelavis/app" }),
      });
      const body = await response.json();

      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.project.app.name, "@zelavis/app");
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
        body: JSON.stringify({ name: "alpha_only", surface: "database" }),
      },
    );
    assert.equal(createCollection.status, 201, await createCollection.text());

    const alphaCollections = await (
      await runtimeRequest(
        "/projects/alpha/proxy/zelavis/api/v1/database/documents/collections",
      )
    ).json();
    const betaCollections = await (
      await runtimeRequest(
        "/projects/beta/proxy/zelavis/api/v1/database/documents/collections",
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
    await assert.rejects(access(join(directory, "zelavis.sqlite")), {
      code: "ENOENT",
    });
    await access(
      join(directory, "projects", "alpha", ".zelavis", "zelavis.sqlite"),
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
    assert.equal(listBody.runtime.driver, "node-process");
    assert.equal(listBody.projects[0].capabilities.secureIsolation, false);
    assert.equal(listBody.projects[0].capabilities.movable, false);
    assert.equal(listBody.projects[0].capabilities.managedDatabase, true);
    assert.equal(
      listBody.projects[0].capabilities.survivesControlPlaneRestart,
      false,
    );
    assert.equal(listBody.projects.length, 2);

    const fabricResponse = await zv.fetch(
      new Request("http://localhost/zelavis/api/v1/fabric/placements/projects/beta"),
    );
    const fabricBody = await fabricResponse.json();
    assert.equal(fabricResponse.status, 200);
    assert.deepEqual(fabricBody.placement.identity, {
      scopeId: "local-platform",
      workloadId: "beta",
      type: "project",
    });
    assert.equal(fabricBody.placement.runtimeNodeId, "local");
    assert.equal(fabricBody.placement.databaseNodeId, "local");
    assert.equal(fabricBody.placement.generation, 1);

    const deleteResponse = await runtimeRequest("/projects/alpha", {
      method: "DELETE",
    });
    const deleteBody = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
    assert.deepEqual(deleteBody, { deleted: true });
    await assert.rejects(access(join(directory, "projects", "alpha")), {
      code: "ENOENT",
    });

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
