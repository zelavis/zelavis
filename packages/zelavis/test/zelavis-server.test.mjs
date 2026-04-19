import assert from "node:assert/strict";
import test from "node:test";
import { defineServerService, zelavisServer } from "../dist/index.js";

test("zelavisServer includes the database core service by default", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.database.name, "database");
  assert.equal(runtime.server, mounted.routes.length);
  assert.ok(mounted.routes.some((route) => route.route.id === "database.health"));
  assert.ok(mounted.routes.some((route) => route.route.id === "database.collections.list"));
});

test("zelavisServer can disable the database core service", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    coreServices: {
      database: false,
    },
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.deepEqual(runtime.services, {});
  assert.equal(runtime.server, 0);
  assert.equal(mounted.routes.length, 0);
});

test("zelavisServer does not duplicate an explicitly provided database service", async () => {
  const databaseService = defineServerService({
    name: "database",
    service: { custom: true },
    api: {
      v1: [
        {
          id: "custom.database",
          method: "GET",
          path: "/custom",
          handler: () => ({ status: 204 }),
        },
      ],
    },
  });
  const mounted = {};

  const runtime = await zelavisServer({
    services: [databaseService],
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.database.service.custom, true);
  assert.equal(mounted.routes.length, 1);
  assert.equal(mounted.routes[0].route.id, "custom.database");
});
