import assert from "node:assert/strict";
import test from "node:test";
import { defineServerService, zelavis } from "../dist/index.js";

test("zelavis includes core services by default", async () => {
  const mounted = {};

  const runtime = await zelavis({
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
  assert.ok(
    mounted.routes.some((route) => route.fullPath === "/zelavis/settings"),
  );
  assert.ok(
    mounted.routes.some((route) => route.fullPath === "/zelavis/*path"),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/dashboard/config",
    ),
  );
  assert.ok(
    mounted.routes.some((route) =>
      route.fullPath.startsWith("/zelavis/assets/"),
    ),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/auth/providers",
    ),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/database/health",
    ),
  );
  assert.ok(
    mounted.routes.some((route) => route.route.id === "auth.providers.list"),
  );
  assert.ok(
    mounted.routes.some((route) => route.route.id === "database.health"),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.route.id === "database.collections.list",
    ),
  );

  const dashboardRoute = mounted.routes.find(
    (route) => route.fullPath === "/zelavis",
  );
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
  assert.match(dashboardResponse.body, /__ZELAVIS_RUNTIME_CONFIG__/);
  assert.match(dashboardResponse.body, /\/zelavis\/assets\//);
  assert.doesNotMatch(dashboardResponse.body, /"\/assets\//);

  const settingsRoute = mounted.routes.find(
    (route) => route.fullPath === "/zelavis/settings",
  );
  const settingsResponse = await settingsRoute.route.handler({
    service: settingsRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(settingsResponse.status, 200);
  assert.match(settingsResponse.body, /\/zelavis\/assets\//);

  const scriptAssetRoute = mounted.routes.find(
    (route) =>
      route.fullPath.startsWith("/zelavis/assets/") &&
      route.fullPath.includes("/index-") &&
      route.fullPath.endsWith(".js"),
  );
  const scriptAssetResponse = await scriptAssetRoute.route.handler({
    service: scriptAssetRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(scriptAssetResponse.status, 200);
  assert.match(scriptAssetResponse.body, /\/zelavis\/assets\//);
  assert.doesNotMatch(scriptAssetResponse.body, /[`"']\/assets\//);
  assert.doesNotMatch(scriptAssetResponse.body, /[`"']assets\//);

  const fallbackRoute = mounted.routes.find(
    (route) => route.fullPath === "/zelavis/*path",
  );
  const fallbackResponse = await fallbackRoute.route.handler({
    service: fallbackRoute.service.service,
    params: { path: "unknown/deep/path" },
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });
  const apiFallbackResponse = await fallbackRoute.route.handler({
    service: fallbackRoute.service.service,
    params: { path: "api/v1/unknown" },
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(fallbackResponse.status, 200);
  assert.match(fallbackResponse.body, /Zelavis Dashboard/);
  assert.equal(apiFallbackResponse.status, 404);
  assert.deepEqual(apiFallbackResponse.body, { error: "Not found" });

  const configRoute = mounted.routes.find(
    (route) => route.fullPath === "/zelavis/api/v1/dashboard/config",
  );
  const configResponse = await configRoute.route.handler({
    service: configRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.body.rootPath, "/zelavis");
  assert.equal(configResponse.body.api.basePath, "/zelavis/api/v1");
  assert.deepEqual(
    configResponse.body.services.map((service) => service.name),
    ["dashboard", "database", "auth"],
  );
});

test("zelavis can disable the database core service", async () => {
  const mounted = {};

  const runtime = await zelavis({
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
  assert.ok(
    mounted.routes.every((route) => !route.route.id.startsWith("database.")),
  );
});

test("zelavis can disable the auth core service", async () => {
  const mounted = {};

  const runtime = await zelavis({
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
  assert.ok(
    mounted.routes.every((route) => !route.route.id.startsWith("auth.")),
  );
});

test("zelavis can disable the dashboard core service", async () => {
  const mounted = {};

  const runtime = await zelavis({
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
  assert.ok(
    mounted.routes.every((route) => !route.route.id.startsWith("dashboard.")),
  );
});

test("zelavis uses a configurable root path for dashboard and APIs", async () => {
  const mounted = {};

  await zelavis({
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
  assert.ok(
    mounted.routes.some((route) => route.fullPath === "/admin/settings"),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/admin/api/v2/dashboard/config",
    ),
  );
  assert.ok(
    mounted.routes.some((route) => route.fullPath.startsWith("/admin/assets/")),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/admin/api/v2/auth/providers",
    ),
  );
  assert.ok(
    mounted.routes.some(
      (route) => route.fullPath === "/admin/api/v2/database/health",
    ),
  );

  const dashboardRoute = mounted.routes.find(
    (route) => route.fullPath === "/admin",
  );
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

  const scriptAssetRoute = mounted.routes.find(
    (route) =>
      route.fullPath.startsWith("/admin/assets/") &&
      route.fullPath.includes("/index-") &&
      route.fullPath.endsWith(".js"),
  );
  const scriptAssetResponse = await scriptAssetRoute.route.handler({
    service: scriptAssetRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.match(scriptAssetResponse.body, /\/admin\/assets\//);
  assert.doesNotMatch(scriptAssetResponse.body, /[`"']\/assets\//);
  assert.doesNotMatch(scriptAssetResponse.body, /[`"']assets\//);
});

test("zelavis can disable all core services", async () => {
  const mounted = {};

  const runtime = await zelavis({
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

test("zelavis does not duplicate an explicitly provided database service", async () => {
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

  const runtime = await zelavis({
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

test("zelavis does not duplicate an explicitly provided auth service", async () => {
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

  const runtime = await zelavis({
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
