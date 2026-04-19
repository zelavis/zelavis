import assert from "node:assert/strict";
import test from "node:test";
import { defineServerService, zelavisServer } from "../dist/index.js";

test("zelavisServer resolves promised services, mounts routes, and returns service map", async () => {
  const serviceApi = { version: "test" };
  const service = Promise.resolve(
    defineServerService({
      name: "orders",
      service: serviceApi,
      api: {
        v1: [
          {
            id: "orders.list",
            method: "GET",
            path: "/",
            handler: () => ({ body: [] }),
          },
        ],
      },
    }),
  );
  const onError = () => ({ status: 500 });
  const mounted = {};

  const runtime = await zelavisServer({
    services: [service],
    prefix: "/api",
    servicePrefixes: {
      orders: "commerce/orders",
    },
    pathOverrides: {
      "orders.list": "/all",
    },
    onError,
    integration: {
      mount(routes, options) {
        mounted.routes = routes;
        mounted.options = options;
        return { mounted: routes.length };
      },
    },
  });

  assert.equal(runtime.server.mounted, 1);
  assert.equal(runtime.services.orders.service, serviceApi);
  assert.equal(mounted.routes[0].fullPath, "/api/commerce/orders/all");
  assert.equal(mounted.routes[0].service.name, "orders");
  assert.equal(mounted.options.onError, onError);
});

test("zelavisServer resolves promised nested services without adding them to the top-level service map", async () => {
  const child = Promise.resolve(
    defineServerService({
      name: "child",
      service: { nested: true },
      api: {
        v1: [
          {
            id: "parent.child",
            method: "GET",
            path: "/",
            handler: () => ({ status: 204 }),
          },
        ],
      },
    }),
  );
  const parent = defineServerService({
    name: "parent",
    service: { root: true },
    api: {},
    services: [child],
  });
  const mounted = {};

  const runtime = await zelavisServer({
    services: [parent],
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.deepEqual(Object.keys(runtime.services), ["parent"]);
  assert.equal(runtime.services.parent.services[0].name, "child");
  assert.equal(runtime.server, 1);
  assert.equal(mounted.routes[0].fullPath, "/parent/child");
  assert.equal(mounted.routes[0].service.name, "child");
});
