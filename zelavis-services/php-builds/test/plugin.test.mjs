import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installAsyncPluginContextStorage } from "../../../packages/zelavis/dist/adapters/_async-plugin-context.js";
import { loadPluginPackage } from "../../../packages/zelavis/dist/service.js";

installAsyncPluginContextStorage();

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const load = () => loadPluginPackage({ manifest, importer: () => import("../dist/index.js") });

test("the manifest names exactly the host operations the service uses, and nothing else", async () => {
  const service = await load();
  assert.deepEqual([...service.hostOperations].sort(), [
    "zelavis.container-probe", "zelavis.host-report", "zelavis.php-build-clean", "zelavis.php-build-start", "zelavis.php-build-status", "zelavis.php-build-upload",
  ]);
  assert.equal(service.namespace, "phpBuilds");
  assert.equal(service.kind, "plugin");
});

test("it registers one operation per capability, each behind its own permission, and a dashboard page", async () => {
  const service = await load();
  const routes = new Map(service.api.v1.map((route) => [route.id, route]));
  assert.deepEqual([...routes.keys()].sort(), ["phpBuilds.builds.create", "phpBuilds.builds.delete", "phpBuilds.builds.get", "phpBuilds.builds.list", "phpBuilds.builds.upload", "phpBuilds.host.get"]);
  for (const [id, route] of routes) {
    const reads = route.method === "GET";
    assert.deepEqual(route.access.permissions, [reads ? "server.php-builds.view" : "server.php-builds.run"], id);
    assert.equal(route.access.scope.type, "system");
  }
  assert.equal(service.menu.page.file, "builds.html");
});

test("without the host's operation Agent every route says so, and with it a request reaches the host as the caller", async () => {
  const bare = await load();
  const list = bare.api.v1.find((route) => route.id === "phpBuilds.builds.list");
  assert.equal((await list.handler({ principal: { id: "owner" } })).status, 503);

  const service = await load();
  const submitted = [];
  const store = new Map();
  await service.setup({
    core: {
      hostOperations: {
        allowed: [],
        submit: async (input, principal) => { submitted.push({ input, principal }); return { operationId: "op1" }; },
        get: async () => ({ operationId: "op1", agent: { status: "succeeded", result: { platform: "linux-aarch64" } } }),
      },
      store: { get: async (key) => store.get(key), set: async (key, value) => { store.set(key, value); }, delete: async () => true, list: async () => [...store].map(([key, value]) => ({ key, value })) },
    },
    addEndpointGroup() {},
  });
  const create = service.api.v1.find((route) => route.id === "phpBuilds.builds.create");
  const caller = { id: "owner" };
  const created = await create.handler({ principal: caller, body: { php: "8.4.23" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "running");
  assert.equal(submitted[0].principal, caller, "the request carries the caller, not the service");
  assert.equal(submitted[0].input.operation, "zelavis.php-build-start");
  const refused = await create.handler({ principal: caller, body: { php: "latest" } });
  assert.equal(refused.status, 400);
});
