import assert from "node:assert/strict";
import test from "node:test";
import { zelavis } from "../dist/sdk/fetch.js";
import { activePluginStorage, createPluginExecutionContext } from "../dist/core/service/context.js";

test("zelavis.createAPI registers APIs under zelavis.plugins[namespace]", () => {
  zelavis.createAPI("customtools", {
    calculator: {
      add(a, b) {
        return a + b;
      },
    },
  });

  assert.ok(zelavis.plugins.customtools);
  assert.equal(typeof zelavis.plugins.customtools.calculator.add, "function");
  assert.equal(zelavis.plugins.customtools.calculator.add(2, 3), 5);
});

test("zelavis.createAPI deep merges multiple registrations under the same namespace", () => {
  zelavis.createAPI("analytics", {
    events: {
      track(name) {
        return `tracked:${name}`;
      },
    },
  });

  zelavis.createAPI("analytics", {
    metrics: {
      gauge(val) {
        return val * 2;
      },
    },
  });

  assert.equal(zelavis.plugins.analytics.events.track("click"), "tracked:click");
  assert.equal(zelavis.plugins.analytics.metrics.gauge(10), 20);
});

test("reading an unknown namespace does not register it", () => {
  assert.equal(zelavis.plugins.nonexistent, undefined);
  assert.equal("nonexistent" in zelavis.plugins, false);
});

test("zelavis.plugins.ui.menus.create works as expected through createAPI", () => {
  const context = createPluginExecutionContext({
    name: "@test/plugin-ui",
    version: "1.0.0",
    zelavis: { kind: "plugin", namespace: "testui" },
  });

  activePluginStorage.run(context, () => {
    const menu = zelavis.plugins.ui.menus.create({
      title: "Dashboard",
      path: "/dash",
    });

    assert.equal(menu.title, "Dashboard");
    assert.equal(context.menus.length, 1);
    assert.equal(context.menus[0].title, "Dashboard");
  });
});

test("zelavis.createAPI infers namespace from active plugin context and generates Web API routes", () => {
  const context = createPluginExecutionContext({
    name: "@acme/ecommerce",
    version: "1.0.0",
    zelavis: { kind: "plugin", namespace: "shop" },
  });

  activePluginStorage.run(context, () => {
    zelavis.createAPI({
      orders: {
        async list(query) {
          return [{ id: "order_1", status: "confirmed", query }];
        },
        async get(input) {
          return { id: input.id, item: "widget" };
        },
        async create(body) {
          return { id: "order_created", ...body };
        },
        async update(body) {
          return { id: body.id, updated: true };
        },
        async delete(input) {
          return { id: input.id, deleted: true };
        },
        async refund(input) {
          return { refunded: true, amount: input.amount };
        },
      },
    });

    // Check JS SDK API
    assert.ok(zelavis.plugins.shop.orders);
    assert.equal(typeof zelavis.plugins.shop.orders.list, "function");
    assert.equal(typeof zelavis.plugins.shop.orders.create, "function");

    // Check auto-generated routes
    assert.equal(context.routes.length, 6);

    const listRoute = context.routes.find((r) => r.id === "shop.orders.list");
    assert.ok(listRoute);
    assert.equal(listRoute.method, "GET");
    assert.equal(listRoute.path, "/orders");
    assert.equal(listRoute.meta.pluginResource, "orders");
    assert.equal(listRoute.meta.pluginAction, "list");

    const getRoute = context.routes.find((r) => r.id === "shop.orders.get");
    assert.ok(getRoute);
    assert.equal(getRoute.method, "GET");
    assert.equal(getRoute.path, "/orders/:id");

    const createRoute = context.routes.find((r) => r.id === "shop.orders.create");
    assert.ok(createRoute);
    assert.equal(createRoute.method, "POST");
    assert.equal(createRoute.path, "/orders");

    const updateRoute = context.routes.find((r) => r.id === "shop.orders.update");
    assert.ok(updateRoute);
    assert.equal(updateRoute.method, "PUT");
    assert.equal(updateRoute.path, "/orders/:id");

    const deleteRoute = context.routes.find((r) => r.id === "shop.orders.delete");
    assert.ok(deleteRoute);
    assert.equal(deleteRoute.method, "DELETE");
    assert.equal(deleteRoute.path, "/orders/:id");

    const refundRoute = context.routes.find((r) => r.id === "shop.orders.refund");
    assert.ok(refundRoute);
    assert.equal(refundRoute.method, "POST");
    assert.equal(refundRoute.path, "/orders/refund");
  });
});

test("auto-generated Web API route handlers execute correctly", async () => {
  const context = createPluginExecutionContext({
    name: "@acme/ecommerce",
    version: "1.0.0",
    zelavis: { kind: "plugin", namespace: "store" },
  });

  let createRoute;
  let listRoute;

  activePluginStorage.run(context, () => {
    zelavis.createAPI({
      products: {
        async list(query) {
          return [{ id: "p1", category: query.category }];
        },
        async create(body) {
          return { id: "p2", name: body.name, price: body.price };
        },
      },
    });

    listRoute = context.routes.find((r) => r.id === "store.products.list");
    createRoute = context.routes.find((r) => r.id === "store.products.create");
  });

  assert.ok(listRoute);
  assert.ok(createRoute);

  // Invoke GET list route
  const getResult = await listRoute.handler({
    query: new URLSearchParams("category=books"),
    params: {},
    headers: {},
  });
  assert.equal(getResult.status, 200);
  assert.deepEqual(getResult.body, [{ id: "p1", category: "books" }]);

  // Invoke POST create route
  const postResult = await createRoute.handler({
    query: new URLSearchParams(),
    params: {},
    headers: {},
    body: { name: "Novel", price: 19.99 },
  });
  assert.equal(postResult.status, 200);
  assert.deepEqual(postResult.body, { id: "p2", name: "Novel", price: 19.99 });
});

test("zelavis.createAPI supports options.routes = false to disable route generation", () => {
  const context = createPluginExecutionContext({
    name: "@acme/internal-tools",
    version: "1.0.0",
    zelavis: { kind: "plugin", namespace: "internal" },
  });

  activePluginStorage.run(context, () => {
    zelavis.createAPI(
      {
        helpers: {
          format(str) {
            return str.toUpperCase();
          },
        },
      },
      { routes: false },
    );

    assert.ok(zelavis.plugins.internal.helpers);
    assert.equal(zelavis.plugins.internal.helpers.format("test"), "TEST");
    assert.equal(context.routes.length, 0);
  });
});

const execution = (namespace = "isolated") => createPluginExecutionContext({
  name: "@test/api", type: "module", exports: "./index.js",
  zelavis: { kind: "plugin", namespace },
});

test("API registrations are isolated and cannot impersonate another namespace", () => {
  const first = execution();
  const second = execution();
  activePluginStorage.run(first, () => {
    assert.throws(() => zelavis.createAPI("ui", { menus: {} }), /manifest namespace/);
    zelavis.createAPI({ items: { async list() { return "first"; } } });
  });
  activePluginStorage.run(second, () => {
    assert.equal(zelavis.plugins.isolated, undefined);
    zelavis.createAPI({ items: { async list() { return "second"; } } });
  });
  assert.equal(zelavis.plugins.isolated, undefined);
  assert.equal(first.routes.length, 1);
  assert.equal(second.routes.length, 1);
});

test("invalid definitions and colliding routes publish no partial registration", () => {
  const context = execution("atomic");
  activePluginStorage.run(context, () => {
    assert.throws(() => zelavis.createAPI({ items: { list() {}, find() {} } }), /Duplicate plugin route/);
    assert.equal(context.routes.length, 0);
    assert.equal(zelavis.plugins.atomic, undefined);
    assert.throws(() => zelavis.createAPI({ items: { "bad-name"() {} } }), /namespace/);
    assert.equal(context.routes.length, 0);
    zelavis.createAPI({ items: { list() {} } });
    assert.throws(() => zelavis.createAPI({ items: { list() {} } }), /Duplicate plugin API/);
    assert.equal(context.routes.length, 1);
  });
  assert.throws(() => zelavis.createAPI({}), /explicit namespace/);
  assert.throws(() => zelavis.createAPI("invalid", []), /definition object/);
});

test("IDs come from the path, object results stay data, and methods retain this", async () => {
  const context = execution("inputs");
  activePluginStorage.run(context, () => {
    zelavis.createAPI({ items: {
      label: "item",
      get(input) { return { status: "active", body: input, label: this.label }; },
      update(input) { return input; },
      delete(input) { return input; },
    } });
  });
  const invoke = (action, body) => context.routes.find(r => r.meta.pluginAction === action).handler({
    params: { id: "correct" }, query: new URLSearchParams("id=wrong"), body, headers: {},
  });
  assert.deepEqual((await invoke("get")).body, { status: "active", body: { id: "correct" }, label: "item" });
  assert.deepEqual((await invoke("update", { id: "wrong", value: 1 })).body, { id: "correct", value: 1 });
  assert.deepEqual((await invoke("delete")).body, { id: "correct" });
});

test("generated APIs share HTTP, SDK, CLI, authorization and installation lifecycle", async (t) => {
  const { loadPluginPackage } = await import("../dist/service.js");
  const { zelavis: boot } = await import("../dist/index.js");
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runPluginsCommand } = await import("../dist/cli/plugins.js");
  const service = await loadPluginPackage({ manifest: execution("generated").manifest, importer: async () => {
    zelavis.createAPI({ items: {
      async list(input) { return [{ status: "active", filter: input.filter }]; },
      async get(input) { return input; },
      async update(input) { return input; },
      async delete(input) { return input; },
    } }, { access: { permissions: ["items.manage"], scope: { type: "system" } } });
    return {};
  } });
  const runtime = await boot({ rootPath: "/custom", serviceRegistry: { catalog: [{ service, status: "installed" }] } });
  t.after(() => runtime.close());
  const owner = { principal: { id: "owner", type: "user", permissions: ["*"] } };
  const fetcher = (url, init) => runtime.fetch(new Request(url, init), owner);
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/custom", fetch: fetcher });
  const expected = [{ status: "active", filter: "books" }];
  assert.deepEqual(await (await fetcher("http://localhost/custom/api/v1/plugins/generated/items?filter=books")).json(), expected);
  assert.deepEqual(await client.plugins.generated.items.list(undefined, { query: { filter: "books" } }), expected);
  assert.deepEqual(await client.plugins.generated.items.get(undefined, { params: { id: "a b" } }), { id: "a b" });
  assert.deepEqual(await client.plugins.generated.items.update({ id: "wrong", value: 1 }, { params: { id: "right" } }), { id: "right", value: 1 });
  assert.deepEqual(await client.plugins.generated.items.delete(undefined, { params: { id: "right" } }), { id: "right" });
  assert.equal((await client.pluginOperations()).length, 4);
  const anonymous = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/custom", fetch: (url, init) => runtime.fetch(new Request(url, init)) });
  await assert.rejects(anonymous.plugins.generated.items.list(), error => [401, 403].includes(error.response.status));
  const inactive = await boot({ serviceRegistry: { catalog: [{ service, status: "available" }] } });
  t.after(() => inactive.close());
  assert.equal((await inactive.fetch(new Request("http://localhost/zelavis/api/v1/plugins/generated/items"), owner)).status, 404);
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const output = [];
  globalThis.fetch = fetcher;
  console.log = value => output.push(value);
  try {
    await runPluginsCommand(["generated", "items", "get", "--param", "id=right", "--url", "http://localhost/custom", "--json"]);
    assert.deepEqual(JSON.parse(output.pop()), { id: "right" });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("the UI namespace can add capabilities while retaining the menu authoring contract", () => {
  activePluginStorage.run(execution("ui"), () => {
    zelavis.createAPI({ panels: { list() { return []; } } });
    zelavis.plugins.ui.menus.create({ title: "UI" });
    assert.equal(zelavis.context().menus.length, 1);
    assert.equal(zelavis.context().routes.length, 1);
    assert.throws(() => zelavis.createAPI({ menus: { create() {} } }), /Duplicate plugin API/);
  });
});

test("first SDK evaluation inside a plugin context does not register UI routes there", async () => {
  const context = execution("firstImport");
  await activePluginStorage.run(context, async () => {
    const { pluginsProxy } = await import("../dist/sdk/create-api.js?first-import");
    pluginsProxy.ui.menus.create({ title: "First import" });
    assert.equal(context.menus.length, 1);
    assert.equal(context.routes.length, 0);
  });
});
