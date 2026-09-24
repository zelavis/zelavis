import { createMemoryServiceRegistryStore } from "../dist/platform/settings.js";
import assert from "node:assert/strict";
import test from "node:test";
import { zelavis, createMemorySystemStore } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { listRuntimeServices, listRuntimeExtensions, listRuntimeServiceSources } from "../dist/cli/services.js";
import { runCli } from "../dist/cli/commands.js";

test("public catalogues share identity without exposing acquisition references", async (t) => {
  const privateSource = "file:///private/operator/packages/plugin.js?token=private-source";
  const storedSource = "https://registry.example/package.tgz?token=stored-secret";
  const stored = [{ name: "@example/unloaded", specifier: storedSource, status: "available" }];
  const store = createMemoryServiceRegistryStore(stored);
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    serviceRegistry: {
      store,
      catalog: [
        {
          specifier: privateSource, status: "installed", source: "community",
          service: {
            name: "@example/extension", namespace: "example", version: "1.2.3",
            kind: "plugin", service: {}, api: {}, capabilities: ["zelavis/identity:oauth"],
          },
        },
        {
          specifier: privateSource, status: "available", source: "community",
          service: {
            name: "@example/recipe", version: "2.0.0", kind: "app", service: {}, api: {},
            project: { runtimeKinds: ["native"] },
          },
        },
      ],
    },
  });
  t.after(() => runtime.close());
  const principal = { id: "user", type: "user" };
  const fetcher = (input, init) => runtime.fetch(new Request(input, init), { principal });
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  const config = await client.runtime.config();
  const services = await listRuntimeServices({ url: "http://localhost/zelavis", fetch: fetcher });
  const extensions = await listRuntimeExtensions({ url: "http://localhost/zelavis", fetch: fetcher });
  const recipes = await client.json("/runtime/project-recipes");
  for (const response of [config, services, extensions, recipes]) {
    const encoded = JSON.stringify(response);
    assert.ok(!encoded.includes(privateSource));
    assert.ok(!encoded.includes(storedSource));
    assert.ok(!encoded.includes('"specifier"'));
  }
  const configured = config.serviceRegistry.find((entry) => entry.name === "@example/extension");
  const listed = services.find((entry) => entry.name === configured.name);
  for (const key of ["name", "namespace", "version", "kind", "status", "source", "order"]) {
    assert.equal(listed[key], configured[key], key);
  }
  assert.equal(services.find((entry) => entry.name === "@example/unloaded").status, "available");
  assert.equal(recipes.projectRecipes.find((entry) => entry.name === "@example/recipe").version, "2.0.0");
  // Source references remain intact in private persisted state for activation.
  assert.equal(store.read()[0].specifier, storedSource);

  const sourcePath = "http://localhost/zelavis/api/v1/runtime/services/sources";
  for (const caller of [
    undefined,
    { id: "user", type: "user" },
    { id: "project", type: "user", grants: [{ permission: "system.services.manage", scope: { type: "project", projectId: "alpha" } }] },
  ]) {
    const response = await runtime.fetch(new Request(sourcePath), { principal: caller });
    assert.equal(response.status, caller ? 403 : 401);
    assert.ok(!(await response.text()).includes(storedSource));
  }
  const administrator = { id: "admin", type: "user", permissions: ["system.services.manage"] };
  const adminFetch = (input, init) => runtime.fetch(new Request(input, init), { principal: administrator });
  const adminClient = createZelavisClient({ baseUrl: "http://localhost", fetch: adminFetch });
  const diagnostic = await adminClient.runtime.serviceSources();
  assert.equal(diagnostic.sources.find((entry) => entry.name === "@example/unloaded").specifier, storedSource);
  const direct = await adminFetch(sourcePath);
  assert.equal(direct.headers.get("cache-control"), "no-store");
  assert.deepEqual(await listRuntimeServiceSources({ url: "http://localhost/zelavis", fetch: adminFetch }), diagnostic.sources);

  // Exercise the actual command parser and JSON output with session transport.
  const output = [];
  t.mock.method(console, "log", (message) => output.push(message));
  t.mock.method(globalThis, "fetch", (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cli-test-session");
    return adminFetch(input, init);
  });
  await runCli(["services", "sources", "--url", "http://localhost/zelavis", "--token", "cli-test-session"]);
  assert.deepEqual(JSON.parse(output[0]), diagnostic);
});
