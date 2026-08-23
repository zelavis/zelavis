import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Zelavis,
  createAssistantManager,
  createBlueprintRegistry,
  createMemorySystemStore,
  parseBlueprintManifest,
} from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";

const appManifest = {
  schemaVersion: 1,
  id: "zelavis/app",
  name: "Zelavis App",
  version: "1.0.1-alpha.2",
  kind: "zelavis-app",
  description: "Official application backend.",
  source: "official",
  status: "development",
  runtime: {
    type: "javascript",
    engines: ["node", "bun", "deno"],
  },
};

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

test("Blueprint registry validates identities and resolves versions", () => {
  const manifest = parseBlueprintManifest(appManifest);
  const registry = createBlueprintRegistry([
    { manifest, origin: "shipped", directory: "/blueprints/app/latest" },
  ]);

  assert.equal(registry.list().length, 1);
  assert.equal(registry.get("zelavis/app")?.manifest.name, "Zelavis App");
  assert.equal(
    registry.get("zelavis/app", "1.0.1-alpha.2")?.origin,
    "shipped",
  );
  assert.throws(
    () =>
      createBlueprintRegistry([
        { manifest, origin: "shipped" },
        { manifest, origin: "cache" },
      ]),
    /Duplicate blueprint/,
  );
});

test("Node adapter loads shipped blueprints and persists Platform Store SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-platform-"));

  try {
    const firstAdapter = nodeAdapter({ dataDirectory: directory });
    const first = await firstAdapter.resolve({});
    const systemStore = first.resources?.systemStore;
    const blueprints = first.resources?.blueprints;

    assert.ok(systemStore);
    assert.equal(first.coreServices.database, false);
    assert.equal(first.coreServices.website, false);
    assert.equal(first.coreServices.storage, false);
    assert.equal(first.coreServices.workloads, false);
    assert.equal(first.metadata.role, "platform");
    assert.equal(blueprints?.get("zelavis/app")?.origin, "shipped");
    await systemStore.set("platform", "marker", { ready: true });

    const second = await nodeAdapter({ dataDirectory: directory }).resolve({});
    assert.deepEqual(
      (await second.resources.systemStore.get("platform", "marker"))?.value,
      { ready: true },
    );

    const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });
    const runtime = await zv.runtime();
    const response = await runtime.fetch(
      new Request("http://localhost/zelavis/api/v1/runtime/blueprints"),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.blueprints[0].id, "zelavis/app");
    assert.equal(body.blueprints[0].origin, "shipped");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  let alphaRuntimeUrl;

  try {
    for (const [id, name] of [
      ["alpha", "Alpha"],
      ["beta", "Beta"],
    ]) {
      const response = await runtimeRequest("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name, blueprintId: "zelavis/app" }),
      });
      const body = await response.json();

      assert.equal(response.status, 201, JSON.stringify(body));
      assert.equal(body.project.runtime.status, "running");
      assert.match(body.project.runtime.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      if (id === "alpha") {
        alphaRuntimeUrl = body.project.runtime.url;
      }
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

    const childDashboardResponse = await fetch(`${alphaRuntimeUrl}/zelavis`);
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
    assert.equal(listBody.runtime.capabilities.secureIsolation, false);
    assert.equal(listBody.projects.length, 2);

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
    for (const id of ["alpha", "beta"]) {
      await runtimeRequest(`/projects/${id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
