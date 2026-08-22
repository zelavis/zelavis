import { afterEach, expect, test, vi } from "vitest";

import {
  getResolvedDashboardPreferences,
  resolveRuntimeDynamicMenus,
  type RuntimeConfig,
} from "./runtime-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("getResolvedDashboardPreferences falls back to an empty object when preferences are missing", () => {
  expect(getResolvedDashboardPreferences({})).toEqual({});
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
