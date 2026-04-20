import assert from "node:assert/strict";
import test from "node:test";
import { defineServerService, zelavisServer } from "../dist/index.js";

test("zelavisServer includes core services by default", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.dashboard.name, "dashboard");
  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.database.name, "database");
  assert.equal(runtime.server, mounted.routes.length);
  assert.ok(mounted.routes.some((route) => route.fullPath === "/zelavis"));
  assert.ok(mounted.routes.some((route) => route.fullPath.startsWith("/zelavis/assets/")));
  assert.ok(mounted.routes.some((route) => route.fullPath === "/zelavis/api/v1/auth/providers"));
  assert.ok(mounted.routes.some((route) => route.fullPath === "/zelavis/api/v1/database/health"));
  assert.ok(mounted.routes.some((route) => route.route.id === "auth.providers.list"));
  assert.ok(mounted.routes.some((route) => route.route.id === "database.health"));
  assert.ok(mounted.routes.some((route) => route.route.id === "database.collections.list"));

  const dashboardRoute = mounted.routes.find((route) => route.fullPath === "/zelavis");
  const dashboardResponse = await dashboardRoute.route.handler({
    service: dashboardRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardResponse.body, /Zelavis Dashboard/);
  assert.match(dashboardResponse.body, /\/zelavis\/assets\//);
  assert.doesNotMatch(dashboardResponse.body, /"\/assets\//);
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

  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.database, undefined);
  assert.ok(mounted.routes.every((route) => !route.route.id.startsWith("database.")));
});

test("zelavisServer can disable the auth core service", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    coreServices: {
      auth: false,
    },
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.auth, undefined);
  assert.equal(runtime.services.database.name, "database");
  assert.ok(mounted.routes.every((route) => !route.route.id.startsWith("auth.")));
});

test("zelavisServer can disable the dashboard core service", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    coreServices: {
      dashboard: false,
    },
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.dashboard, undefined);
  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.database.name, "database");
  assert.ok(mounted.routes.every((route) => !route.route.id.startsWith("dashboard.")));
});

test("zelavisServer uses a configurable root path for dashboard and APIs", async () => {
  const mounted = {};

  await zelavisServer({
    rootPath: "/admin",
    api: {
      version: "v2",
    },
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.ok(mounted.routes.some((route) => route.fullPath === "/admin"));
  assert.ok(mounted.routes.some((route) => route.fullPath.startsWith("/admin/assets/")));
  assert.ok(mounted.routes.some((route) => route.fullPath === "/admin/api/v2/auth/providers"));
  assert.ok(mounted.routes.some((route) => route.fullPath === "/admin/api/v2/database/health"));

  const dashboardRoute = mounted.routes.find((route) => route.fullPath === "/admin");
  const dashboardResponse = await dashboardRoute.route.handler({
    service: dashboardRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.match(dashboardResponse.body, /\/admin\/assets\//);
  assert.doesNotMatch(dashboardResponse.body, /"\/assets\//);
});

test("zelavisServer can disable all core services", async () => {
  const mounted = {};

  const runtime = await zelavisServer({
    coreServices: {
      auth: false,
      dashboard: false,
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
    coreServices: {
      auth: false,
      dashboard: false,
    },
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

test("zelavisServer does not duplicate an explicitly provided auth service", async () => {
  const authService = defineServerService({
    name: "auth",
    service: { custom: true },
    api: {
      v1: [
        {
          id: "custom.auth",
          method: "GET",
          path: "/custom",
          handler: () => ({ status: 204 }),
        },
      ],
    },
  });
  const mounted = {};

  const runtime = await zelavisServer({
    coreServices: {
      dashboard: false,
      database: false,
    },
    services: [authService],
    integration: {
      mount(routes) {
        mounted.routes = routes;
        return routes.length;
      },
    },
  });

  assert.equal(runtime.services.auth.service.custom, true);
  assert.equal(mounted.routes.length, 1);
  assert.equal(mounted.routes[0].route.id, "custom.auth");
});
