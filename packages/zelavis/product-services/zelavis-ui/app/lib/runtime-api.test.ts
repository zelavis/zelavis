import { afterEach, expect, test, vi } from "vitest";

import {
  getResolvedDashboardPreferences,
  normalizeRuntimeProject,
  resolveRuntimeDynamicMenus,
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

test("normalizeRuntimeProject recovers a missing app lock for project cards", () => {
  const project = normalizeRuntimeProject({
    id: "vibe",
    name: "Vibe",
    kind: "zelavis",
    desiredState: "running",
    runtime: {
      driver: "node",
      status: "running",
      url: "http://127.0.0.1:3100",
    },
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  } as RuntimeProject);

  expect(project.app).toEqual({
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
        core: true,
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
        core: true,
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
