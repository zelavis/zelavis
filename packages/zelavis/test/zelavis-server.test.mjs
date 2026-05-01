import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase, defineServerService, zelavis } from "../dist/index.js";

test("zelavis exposes fetch handlers without requiring a mount adapter", async () => {
  const runtime = await zelavis({});

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/dashboard/config"),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.rootPath, "/zelavis");
  assert.equal(payload.api.basePath, "/zelavis/api/v1");
  assert.deepEqual(
    payload.services.map((service) => service.name),
    ["dashboard", "database", "auth", "website"],
  );
});

test("zelavis includes core services by default", async () => {
  const runtime = await zelavis({});
  const routes = runtime.routes;

  assert.equal(runtime.services.dashboard.name, "dashboard");
  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.database.name, "database");
  assert.equal(runtime.services.website.name, "website");
  assert.ok(routes.some((route) => route.fullPath === "/*path"));
  assert.ok(routes.some((route) => route.fullPath === "/zelavis"));
  assert.ok(routes.some((route) => route.fullPath === "/zelavis/settings"));
  assert.ok(routes.some((route) => route.fullPath === "/zelavis/*path"));
  assert.ok(
    routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/dashboard/config",
    ),
  );
  assert.ok(
    routes.some((route) => route.fullPath.startsWith("/zelavis/assets/")),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/zelavis/api/v1/auth/providers"),
  );
  assert.ok(
    routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/database/health",
    ),
  );
  assert.ok(routes.some((route) => route.route.id === "auth.providers.list"));
  assert.ok(routes.some((route) => route.route.id === "database.health"));
  assert.ok(
    routes.some((route) => route.route.id === "database.collections.list"),
  );

  const dashboardRoute = routes.find((route) => route.fullPath === "/zelavis");
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

  const settingsRoute = routes.find(
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

  const scriptAssetRoute = routes.find(
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

  const fallbackRoute = routes.find(
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

  const configRoute = routes.find(
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
    ["dashboard", "database", "auth", "website"],
  );

  const dashboardSettingsRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/dashboard/settings" &&
      route.route.method === "GET",
  );
  const dashboardSettingsResponse = await dashboardSettingsRoute.route.handler({
    service: dashboardSettingsRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: undefined,
  });

  assert.equal(dashboardSettingsResponse.status, 200);
  assert.equal(dashboardSettingsResponse.body.rootPath, "/zelavis");
  assert.equal(dashboardSettingsResponse.body.apiBasePath, "/zelavis/api/v1");
  assert.equal(dashboardSettingsResponse.body.persistence, "runtime");
  assert.equal(dashboardSettingsResponse.body.restartRequired, false);
  assert.deepEqual(dashboardSettingsResponse.body.editable, {
    rootPath: true,
    theme: true,
    pageBuilder: true,
  });

  const updateRoute = routes.find(
    (route) =>
      route.fullPath === "/zelavis/api/v1/dashboard/settings" &&
      route.route.method === "PATCH",
  );
  const updateResponse = await updateRoute.route.handler({
    service: updateRoute.service.service,
    params: {},
    query: new URLSearchParams(),
    body: {
      rootPath: "/admin",
      theme: "dark",
    },
    headers: {},
    request: undefined,
  });

  assert.equal(updateResponse.status, 200);
  assert.equal(updateResponse.body.rootPath, "/zelavis");
  assert.equal(updateResponse.body.pendingRootPath, "/admin");
  assert.equal(updateResponse.body.theme, "dark");
  assert.equal(updateResponse.body.restartRequired, true);
});

test("zelavis can disable the database core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      database: false,
    },
  });

  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.website.name, "website");
  assert.equal(runtime.services.database, undefined);
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("database.")),
  );
});

test("zelavis can disable the auth core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
    },
  });

  assert.equal(runtime.services.auth, undefined);
  assert.equal(runtime.services.database.name, "database");
  assert.equal(runtime.services.website.name, "website");
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("auth.")),
  );
});

test("zelavis can disable the dashboard core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      dashboard: false,
    },
  });

  assert.equal(runtime.services.dashboard, undefined);
  assert.equal(runtime.services.auth.name, "auth");
  assert.equal(runtime.services.database.name, "database");
  assert.equal(runtime.services.website.name, "website");
  assert.ok(
    runtime.routes.every((route) => !route.route.id.startsWith("dashboard.")),
  );
});

test("zelavis uses a configurable root path for dashboard and APIs", async () => {
  const runtime = await zelavis({
    rootPath: "/admin",
    api: {
      version: "v2",
    },
  });
  const routes = runtime.routes;

  assert.ok(routes.some((route) => route.fullPath === "/admin"));
  assert.ok(routes.some((route) => route.fullPath === "/admin/settings"));
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/dashboard/config"),
  );
  assert.ok(
    routes.some((route) => route.fullPath.startsWith("/admin/assets/")),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/auth/providers"),
  );
  assert.ok(
    routes.some((route) => route.fullPath === "/admin/api/v2/database/health"),
  );

  const dashboardRoute = routes.find((route) => route.fullPath === "/admin");
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

  const scriptAssetRoute = routes.find(
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

test("zelavis supports mounting at the root path when explicitly configured", async () => {
  const runtime = await zelavis({
    rootPath: "/",
  });

  assert.ok(runtime.routes.some((route) => route.fullPath === "/"));
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/api/v1/dashboard/config",
    ),
  );

  const response = await runtime.fetch(
    new Request("http://localhost/api/v1/dashboard/config"),
  );

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.rootPath, "/");
  assert.equal(payload.api.basePath, "/api/v1");
});

test("zelavis can redirect dashboard routes to a UI dev server", async () => {
  const runtime = await zelavis({
    coreServices: {
      dashboard: {
        devServerUrl: "http://127.0.0.1:3001",
      },
    },
  });
  const routes = runtime.routes;

  const settingsRoute = routes.find(
    (route) => route.fullPath === "/zelavis/settings",
  );
  const settingsResponse = await settingsRoute.route.handler({
    service: settingsRoute.service.service,
    params: {},
    query: new URLSearchParams("tab=auth"),
    body: undefined,
    headers: {},
    request: { url: "/zelavis/settings?tab=auth" },
  });

  assert.equal(settingsResponse.status, 307);
  assert.equal(
    settingsResponse.headers.location,
    "http://127.0.0.1:3001/settings?tab=auth",
  );

  const fallbackRoute = routes.find(
    (route) => route.fullPath === "/zelavis/*path",
  );
  const fallbackResponse = await fallbackRoute.route.handler({
    service: fallbackRoute.service.service,
    params: { path: "nested/panel" },
    query: new URLSearchParams(),
    body: undefined,
    headers: {},
    request: { url: "/zelavis/nested/panel" },
  });

  assert.equal(fallbackResponse.status, 307);
  assert.equal(
    fallbackResponse.headers.location,
    "http://127.0.0.1:3001/nested/panel",
  );
  assert.ok(
    routes.every((route) => !route.route.id.startsWith("dashboard.assets")),
  );
});

test("zelavis can disable all core services", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      dashboard: false,
      database: false,
      website: false,
    },
  });

  assert.deepEqual(runtime.services, {});
  assert.equal(runtime.routes.length, 0);
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
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      dashboard: false,
      website: false,
    },
    services: [databaseService],
  });

  assert.equal(runtime.services.database.service.custom, true);
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].route.id, "custom.database");
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
  const runtime = await zelavis({
    coreServices: {
      dashboard: false,
      database: false,
      website: false,
    },
    services: [authService],
  });

  assert.equal(runtime.services.auth.service.custom, true);
  assert.equal(runtime.routes.length, 1);
  assert.equal(runtime.routes[0].route.id, "custom.auth");
});

test("zelavis can provide public website pages as a core service", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      database: false,
      website: true,
    },
  });

  assert.equal(runtime.services.website.name, "website");
  assert.equal(runtime.services.dashboard.name, "dashboard");
  assert.ok(runtime.routes.some((route) => route.fullPath === "/*path"));
  assert.ok(runtime.routes.some((route) => route.fullPath === "/zelavis"));
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/dashboard/config",
    ),
  );
  assert.ok(
    runtime.routes.some(
      (route) => route.fullPath === "/zelavis/api/v1/website/pages",
    ),
  );

  const listPagesResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages"),
  );
  assert.equal(listPagesResponse.status, 200);
  const listedPagesPayload = await listPagesResponse.json();
  assert.equal(Array.isArray(listedPagesPayload.pages), true);

  const createPageResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Public company page.",
      }),
    }),
  );
  assert.equal(createPageResponse.status, 201);
  const createdPage = await createPageResponse.json();
  assert.equal(createdPage.path, "/about");
  assert.equal(createdPage.title, "About");

  const createHomeResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Zelavis",
        path: "/",
        headline: "Composable backend platform.",
        description: "Public pages can now be served by Zelavis.",
      }),
    }),
  );
  assert.equal(createHomeResponse.status, 201);

  const createDocsResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Docs",
        path: "/docs",
        headline: "Docs placeholder",
        description: "Docs will be mounted here later.",
      }),
    }),
  );
  assert.equal(createDocsResponse.status, 201);

  const homeResponse = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Composable backend platform/);

  const docsResponse = await runtime.fetch(
    new Request("http://localhost/docs"),
  );
  assert.equal(docsResponse.status, 200);
  assert.match(await docsResponse.text(), /Docs placeholder/);

  const aboutResponse = await runtime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 200);
  assert.match(await aboutResponse.text(), /About Zelavis/);

  const dashboardResponse = await runtime.fetch(
    new Request("http://localhost/zelavis"),
  );
  assert.equal(dashboardResponse.status, 200);
  assert.match(await dashboardResponse.text(), /Zelavis Dashboard/);
});

test("zelavis keeps public routes inactive until the home page exists", async () => {
  const runtime = await zelavis({
    coreServices: {
      auth: false,
      database: false,
      website: true,
    },
  });

  const createAboutResponse = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Public company page.",
      }),
    }),
  );
  assert.equal(createAboutResponse.status, 201);

  const homeResponse = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(homeResponse.status, 307);
  assert.equal(homeResponse.headers.get("location"), "/zelavis");

  const aboutResponse = await runtime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 404);
});

test("zelavis persists dashboard settings and website pages through the database layer", async () => {
  const database = await createDatabase();

  const firstRuntime = await zelavis({
    coreServices: {
      auth: false,
      database,
      website: true,
    },
  });

  const initialHomeResponse = await firstRuntime.fetch(
    new Request("http://localhost/"),
  );
  assert.equal(initialHomeResponse.status, 307);
  assert.equal(initialHomeResponse.headers.get("location"), "/zelavis");

  const createPageResponse = await firstRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "About",
        path: "/about",
        headline: "About Zelavis",
        description: "Persisted through the shared database layer.",
      }),
    }),
  );
  assert.equal(createPageResponse.status, 201);

  const aboutBeforeHomeResponse = await firstRuntime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutBeforeHomeResponse.status, 404);

  const createHomePageResponse = await firstRuntime.fetch(
    new Request("http://localhost/zelavis/api/v1/website/pages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Home",
        path: "/",
        headline: "Welcome to Zelavis",
        description: "Seeded through the shared database layer.",
      }),
    }),
  );
  assert.equal(createHomePageResponse.status, 201);

  const restartedRuntime = await zelavis({
    coreServices: {
      auth: false,
      database,
      website: true,
    },
  });

  const homeResponse = await restartedRuntime.fetch(
    new Request("http://localhost/"),
  );
  assert.equal(homeResponse.status, 200);
  assert.match(
    await homeResponse.text(),
    /Seeded through the shared database layer/,
  );

  const aboutResponse = await restartedRuntime.fetch(
    new Request("http://localhost/about"),
  );
  assert.equal(aboutResponse.status, 200);
  assert.match(
    await aboutResponse.text(),
    /Persisted through the shared database layer/,
  );
});
