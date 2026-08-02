import { describe, expect, it } from "vitest";
import {
  buildPlatformNavItems,
  projectManagementNavItems,
  buildWorkspaceServiceNavItems,
  findServiceMenuPageByPath,
  type DashboardNavItem,
} from "./dashboard-data";
import type { RuntimeServiceRegistryEntry, RuntimeService } from "./runtime-api";

function findNavItem(
  items: readonly DashboardNavItem[],
  title: string,
): DashboardNavItem | undefined {
  for (const item of items) {
    if (item.title === title) {
      return item;
    }

    const nested = item.items ? findNavItem(item.items, title) : undefined;
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

describe("dashboard navigation ownership", () => {
  it("keeps installed services to one root workspace item with nested slides underneath", () => {
    const services = [
      {
        name: "@zelavis/ecommerce",
        status: "installed",
        source: "official",
        menu: {
          title: "Ecommerce",
          path: "/commerce",
          items: [
            {
              title: "Orders",
              path: "/commerce/orders",
            },
          ],
        },
      },
    ] satisfies readonly RuntimeServiceRegistryEntry[];

    const workspaceItems = buildWorkspaceServiceNavItems(services);
    expect(workspaceItems).toHaveLength(1);
    expect(workspaceItems[0]?.title).toBe("Ecommerce");
    expect(workspaceItems[0]?.items?.map((item) => item.title)).toEqual(["Orders"]);

    const nav = buildPlatformNavItems([], services);
    const workspace = nav.find((item) => item.title === "Workspace");
    expect(workspace?.items?.some((item) => item.title === "Ecommerce")).toBe(true);
    expect(nav.some((item) => item.title === "Ecommerce")).toBe(false);
  });

  it("keeps arbitrary service dashboard paths clickable and page-resolvable", () => {
    const services = [
      {
        name: "@zelavis/example-plugin-basic",
        status: "installed",
        source: "community",
        menu: {
          title: "Example Basic",
          path: "/example-basic",
          page: {
            id: "dashboard",
            src: "/zelavis/api/v1/runtime/service-pages/%40zelavis%2Fexample-plugin-basic/dashboard",
          },
        },
      },
    ] satisfies readonly RuntimeServiceRegistryEntry[];

    const [item] = buildWorkspaceServiceNavItems(services);

    expect(item?.url).toBe("/example-basic");
    expect(findServiceMenuPageByPath("/example-basic", services)?.id).toBe("dashboard");
  });

  it("allows core services to declare their dashboard surface explicitly", () => {
    const services = [
      {
        name: "@example/insights",
        core: true,
        apiPath: "/api/v1/insights",
        menu: {
          title: "Insights",
          path: "/users",
          surface: "root",
        },
      },
      {
        name: "@example/jobs",
        core: true,
        apiPath: "/api/v1/jobs",
        menu: {
          title: "Jobs",
          path: "/settings",
          surface: "settings",
        },
      },
    ] satisfies readonly RuntimeService[];

    const nav = buildPlatformNavItems(services, []);

    expect(nav.some((item) => item.title === "Insights")).toBe(true);
    expect(findNavItem(nav, "Jobs")).toBeDefined();

    const settings = nav.find((item) => item.title === "Settings");
    expect(settings?.items?.some((item) => item.title === "Jobs")).toBe(true);
  });

  it("exposes project Website and project-wide Media without the old Builder area", () => {
    const nav = buildPlatformNavItems();

    expect(nav.some((item) => item.title === "Website")).toBe(true);
    expect(findNavItem(nav, "Website")).toMatchObject({
      url: "/projects/default/website",
      pageLabel: "Website",
    });
    expect(findNavItem(nav, "Media")).toMatchObject({
      url: "/projects/default/media",
      pageLabel: "Media",
    });
    expect(findNavItem(nav, "Marketplace")).toMatchObject({
      url: "/projects/default/marketplace",
      pageLabel: "Marketplace",
    });
    expect(findNavItem(nav, "Builder")).toBeUndefined();
  });

  it("uses a management nav for the all-projects view", () => {
    expect(projectManagementNavItems.map((item) => item.title)).toEqual([
      "Projects",
      "New Project",
      "Marketplace",
      "Server",
    ]);
    expect(findNavItem(projectManagementNavItems, "Users")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Website")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Marketplace")).toMatchObject({
      url: "/marketplace",
      pageLabel: "Marketplace",
    });
    expect(findNavItem(projectManagementNavItems, "Domains")).toMatchObject({
      url: "/server/domains",
      pageLabel: "Domains",
    });
    expect(findNavItem(projectManagementNavItems, "New Project")?.search).toEqual({
      new: "1",
    });
  });

  it("lists database collections as tables in the database sidebar slide", () => {
    const services = [
      {
        name: "@zelavis/db",
        core: true,
        apiPath: "/api/v1/database",
        menu: {
          title: "Database",
          surface: "core",
          panelLabel: "Database",
          items: [
            {
              title: "System Tables",
              panelLabel: "System Tables",
              items: [
                { title: "zv_collections", path: "/database" },
                { title: "zv_events", path: "/database" },
              ],
            },
          ],
        },
      },
    ] satisfies readonly RuntimeService[];

    const nav = buildPlatformNavItems(
      services,
      [],
      [
        {
          name: "fruits",
          label: "Fruits",
          documentCount: 1,
          tenantId: "default",
          activeVersion: null,
          versions: [],
          pinned: false,
          pinnedIndex: Number.MAX_SAFE_INTEGER,
        },
      ],
      [
        {
          name: "audit_log",
          documentCount: 3,
          tenantId: "default",
          createdAt: "2026-06-02T00:00:00.000Z",
          surface: "database" as const,
        },
        {
          name: "fruits",
          documentCount: 1,
          tenantId: "default",
          createdAt: "2026-06-03T00:00:00.000Z",
          surface: "content-studio" as const,
        },
      ],
    );

    const database = findNavItem(nav, "Database");
    expect(database?.items?.map((item) => item.title)).toEqual([
      "Create Table",
      "audit_log",
      "Fruits",
      "System Tables",
    ]);
    expect(findNavItem(database?.items ?? [], "Create Table")).toMatchObject({
      url: "/projects/default/database/new",
      fixed: true,
      fixedOrder: 1,
    });
    expect(findNavItem(nav, "All Content Types")).toMatchObject({
      fixed: true,
      fixedOrder: 1,
    });
    expect(findNavItem(nav, "Add Content Type")).toMatchObject({
      fixed: true,
      fixedOrder: 2,
    });
    expect(findNavItem(database?.items ?? [], "Fruits")?.search).toEqual({
      databaseTable: "fruits",
      systemTable: undefined,
    });
    expect(findNavItem(database?.items ?? [], "audit_log")).toMatchObject({
      sectionLabel: "Tables",
      search: {
        databaseTable: "audit_log",
        systemTable: undefined,
      },
    });
    expect(findNavItem(database?.items ?? [], "zv_collections")).toBeDefined();
  });
});
