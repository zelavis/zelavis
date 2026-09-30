import { afterEach, expect, test, vi } from "vitest";

import {
  getProjectRuntimeConfig,
  getResolvedDashboardPreferences,
  normalizeRuntimeProject,
  resolveRuntimeDynamicMenus,
  selectPlatformProjectServices,
  setProjectRunning,
  type RuntimeConfig,
  type RuntimeProject,
} from "./runtime-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("runtime errors retain the server correlation reference", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({
      error: "The request could not be completed.",
      correlationId: "0123456789abcdef",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
  ));
  const config = {
    api: { basePath: "/zelavis/api/v1" },
  } as RuntimeConfig;

  await expect(setProjectRunning(config, "blogger", true)).rejects.toThrow(
    "The request could not be completed. Reference: 0123456789abcdef.",
  );
});

test("getResolvedDashboardPreferences falls back to an empty object when preferences are missing", () => {
  expect(getResolvedDashboardPreferences({})).toEqual({});
});

test("normalizeRuntimeProject preserves a Project recipe lock", () => {
  const project = normalizeRuntimeProject({
    id: "vibe",
    name: "Vibe",
    kind: "zelavis",
    runtimeKind: "native",
    recipe: {
      name: "zelavis/app",
      title: "Zelavis App",
      specifier: "zelavis/app",
      runtimeKinds: ["native"],
    },
    capabilities: {
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
    },
    desiredState: "running",
    runtime: {
      driver: "node",
      status: "running",
      url: "http://127.0.0.1:3100",
    },
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  } as RuntimeProject);

  expect(project.recipe).toEqual({
    name: "zelavis/app",
    title: "Zelavis App",
    specifier: "zelavis/app",
    runtimeKinds: ["native"],
  });
  expect(project.runtimeKind).toBe("native");
});

test("project dynamic menus stay scoped by the proxy without a project query", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ items: [{ title: "articles", path: "/database" }] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const config = {
    name: "zelavis",
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath:
        "/zelavis/api/v1/runtime/projects/project-a/proxy/zelavis/api/v1",
    },
    dashboard: { title: "zelavis", clientRoutes: [], assetRoot: "/assets" },
    services: [
      {
        name: "@zelavis/db",
        apiPath: "/zelavis/api/v1/database",
        menu: {
          title: "Database",
          dynamicItems: { path: "/database/menu/tables", emptyTitle: "No tables yet" },
        },
      },
    ],
    serviceRegistry: [],
  } satisfies RuntimeConfig;

  const resolved = await resolveRuntimeDynamicMenus(config);

  expect(fetchMock).toHaveBeenCalledWith(
    "/zelavis/api/v1/runtime/projects/project-a/proxy/zelavis/api/v1/database/menu/tables",
    expect.any(Object),
  );
  expect(resolved.services[0]?.menu?.items?.[0]?.title).toBe("articles");
});

test("empty dynamic menus can still route to their empty-state content", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ items: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const config = {
    name: "zelavis",
    rootPath: "/zelavis",
    api: {
      prefix: "/api",
      version: "v1",
      basePath: "/zelavis/api/v1",
    },
    dashboard: { title: "zelavis", clientRoutes: [], assetRoot: "/assets" },
    services: [
      {
        name: "@zelavis/workloads",
        apiPath: "/zelavis/api/v1/workloads",
        menu: {
          title: "Workloads",
          path: "/workloads",
          items: [
            {
              title: "Jobs",
              path: "/workloads/jobs",
              dynamicItems: {
                path: "/workloads/menu/jobs",
                emptyTitle: "No jobs yet",
                emptyPath: "/workloads/jobs",
              },
            },
          ],
        },
      },
    ],
    serviceRegistry: [],
  } satisfies RuntimeConfig;

  const resolved = await resolveRuntimeDynamicMenus(config);
  const jobs = resolved.services[0]?.menu?.items?.[0];

  expect(jobs).toMatchObject({
    title: "Jobs",
    path: "/workloads/jobs",
    items: [
      {
        title: "No jobs yet",
        path: "/workloads/jobs",
        disabled: false,
      },
    ],
  });
});

test("a project's navigation receives the Platform packages' project menus, not its Server menu", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({
      rootPath: "/zelavis",
      api: { basePath: "/zelavis/api/v1", prefix: "/api", version: "v1" },
      services: [{ name: "@zelavis/app", kind: "app", scope: "system", apiPath: "/zelavis/api/v1/@zelavis/app" }],
      serviceRegistry: [],
    }), { headers: { "content-type": "application/json" } }),
  ));
  const control = {
    rootPath: "/zelavis",
    api: { basePath: "/zelavis/api/v1" },
    dashboard: {},
    services: [
      { name: "@zelavis/ui", scope: "system", apiPath: "/", menu: { title: "Server", path: "/server", surface: "platform" } },
      {
        name: "@zelavis/marketplace",
        scope: "system",
        apiPath: "/zelavis/api/v1/plugins/marketplace",
        menus: [
          { title: "Marketplace", path: "/marketplace", surface: "platform" },
          { title: "Marketplace", path: "/marketplace", surface: "root" },
        ],
      },
    ],
  } as unknown as RuntimeConfig;

  const project = await getProjectRuntimeConfig(control, "alpha");
  const marketplace = project.services.find((service) => service.name === "@zelavis/marketplace");

  expect(marketplace?.menus?.map((menu) => menu.surface)).toEqual(["root"]);
  expect(marketplace?.apiPath).toBe("/zelavis/api/v1/plugins/marketplace");
  expect(project.services.some((service) => service.name === "@zelavis/ui")).toBe(false);
});

test("only system packages' Project-surface menus reach a Project, and never platform menus", () => {
  const menu = (surface: "platform" | "root" | "settings" | undefined) => ({ title: "M", path: "/m", surface });
  const services = [
    { name: "@zelavis/marketplace", scope: "system", apiPath: "/a", menus: [menu("platform"), menu("root")] },
    { name: "@zelavis/auth", scope: "system", apiPath: "/b", menu: menu("settings") },
    { name: "@zelavis/only-platform", scope: "system", apiPath: "/c", menu: menu("platform") },
    { name: "@acme/extension", scope: "extension", apiPath: "/d", menu: menu("root") },
    { name: "@zelavis/ui", scope: "system", apiPath: "/", menu: menu("root") },
    { name: "@zelavis/app", scope: "system", apiPath: "/e", menu: menu("root") },
  ] as unknown as RuntimeConfig["services"];

  const selected = selectPlatformProjectServices(services, new Set(["@zelavis/app"]));

  expect(selected.map((service) => service.name)).toEqual(["@zelavis/marketplace", "@zelavis/auth"]);
  expect(selected[0]?.menus?.map((entry) => entry.surface)).toEqual(["root"]);
});
