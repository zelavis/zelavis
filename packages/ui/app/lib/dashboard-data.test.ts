import { describe, expect, it } from "vitest";
import {
  buildManagedProjectNavItems,
  buildPlatformNavItems,
  buildProjectManagementNavItems,
  projectManagementNavItems,
  buildExtensionServiceNavItems,
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
  it("materializes built-in and nested links for the selected project", () => {
    const nav = buildPlatformNavItems([], [], [], [], "browser-test");

    expect(findNavItem(nav, "Overview")?.url).toBe(
      "/projects/browser-test",
    );
    expect(findNavItem(nav, "All Content Types")?.url).toBe(
      "/projects/browser-test/content",
    );
    expect(findNavItem(nav, "Project Settings")?.url).toBe(
      "/projects/browser-test/settings",
    );
  });

  it("keeps installed services to one Extensions item with nested slides underneath", () => {
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

    const extensionItems = buildExtensionServiceNavItems(services);
    expect(extensionItems).toHaveLength(1);
    expect(extensionItems[0]?.title).toBe("Ecommerce");
    expect(extensionItems[0]?.items?.map((item) => item.title)).toEqual(["Orders"]);

    const nav = buildPlatformNavItems(
      [],
      services,
      undefined,
      undefined,
      "project-a",
    );
    const extensions = nav.find((item) => item.title === "Extensions");
    expect(extensions?.items?.some((item) => item.title === "Ecommerce")).toBe(true);
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

    const [item] = buildExtensionServiceNavItems(services);

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
          sectionLabel: "Build",
          access: {
            permissions: ["project.insights.read"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
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

    const nav = buildPlatformNavItems(
      services,
      [],
      undefined,
      undefined,
      "project-a",
    );

    expect(nav.some((item) => item.title === "Insights")).toBe(true);
    expect(findNavItem(nav, "Insights")).toMatchObject({
      url: "/projects/project-a/users",
      sectionLabel: "Build",
      access: {
        permissions: ["project.insights.read"],
        scope: { type: "project", projectId: "project-a" },
      },
    });
    expect(findNavItem(nav, "Jobs")).toBeDefined();

    const settings = nav.find((item) => item.title === "Settings");
    expect(settings?.items?.some((item) => item.title === "Jobs")).toBe(true);
  });

  it("allows core services to declare platform management navigation", () => {
    const nav = buildProjectManagementNavItems([
      {
        name: "@zelavis/server",
        core: true,
        apiPath: "/api/v1/runtime",
        menu: {
          title: "Access",
          path: "/access",
          pageLabel: "Access",
          panelLabel: "Access",
          surface: "platform",
          access: {
            permissions: ["access.manage"],
            scope: { type: "system" },
          },
          items: [
            {
              title: "Users",
              path: "/access/users",
              pageLabel: "Users",
            },
            {
              title: "Permissions",
              path: "/access/permissions",
              pageLabel: "Permissions",
            },
          ],
        },
      },
    ]);

    expect(nav.map((item) => item.title)).toContain("Access");
    expect(findNavItem(nav, "Access")).toMatchObject({
      url: "/access",
      landingUrl: "/access",
      pageLabel: "Access",
      access: {
        permissions: ["access.manage"],
        scope: { type: "system" },
      },
    });
    expect(findNavItem(nav, "Users")).toMatchObject({
      url: "/access/users",
      pageLabel: "Users",
    });
  });

  it("exposes project Website and project-wide Media without the old Builder area", () => {
    const services = [
      {
        name: "@zelavis/website",
        core: true,
        apiPath: "/",
        menu: {
          title: "Website",
          path: "/website",
          pageLabel: "Website",
          sectionLabel: "Build",
          surface: "root",
          access: {
            permissions: ["project.website.manage"],
            scope: { type: "project", projectIdParam: "projectId" },
          },
        },
      },
    ] satisfies readonly RuntimeService[];
    const nav = buildPlatformNavItems(
      services,
      undefined,
      undefined,
      undefined,
      "project-a",
    );

    expect(nav.map((item) => [item.title, item.sectionLabel])).toEqual([
      ["Overview", "Overview"],
      ["Users", "Build"],
      ["Content", "Build"],
      ["Media", "Build"],
      ["Website", "Build"],
      ["Marketplace", "Extend"],
      ["Extensions", "Extend"],
      ["Backend", "Backend"],
      ["Settings", "Settings"],
    ]);
    expect(nav.some((item) => item.title === "Website")).toBe(true);
    expect(findNavItem(nav, "Website")).toMatchObject({
      url: "/projects/project-a/website",
      pageLabel: "Website",
      access: {
        permissions: ["project.website.manage"],
        scope: { type: "project", projectId: "project-a" },
      },
    });
    expect(findNavItem(nav, "Media")).toMatchObject({
      url: "/projects/project-a/media",
      pageLabel: "Media",
    });
    expect(findNavItem(nav, "Marketplace")).toMatchObject({
      url: "/projects/project-a/marketplace",
      pageLabel: "Marketplace",
    });
    const settings = nav.find((item) => item.title === "Settings");
    expect(settings).toMatchObject({
      landingUrl: "/projects/project-a/settings",
    });
    expect(settings?.items?.map((item) => item.title)).toEqual([
      "Project Settings",
    ]);
    expect(findNavItem(nav, "Builder")).toBeUndefined();
  });

  it("groups managed app project navigation like hosting controls", () => {
    const nav = buildManagedProjectNavItems("wp", "wordpress");

    expect(nav.map((item) => [item.title, item.sectionLabel])).toEqual([
      ["Overview", "Overview"],
      ["Domains", "Hosting"],
      ["Files", "Hosting"],
      ["Database", "Hosting"],
      ["Backups", "Operations"],
      ["Logs", "Operations"],
      ["Updates", "Operations"],
      ["WordPress Admin", "Settings"],
    ]);
  });

  it("uses a management nav for the all-projects view", () => {
    expect(projectManagementNavItems.map((item) => item.title)).toEqual([
      "Projects",
      "Access",
      "Marketplace",
      "Domains",
      "Resources",
      "Server",
      "Security",
    ]);
    expect(projectManagementNavItems.map((item) => item.sectionLabel)).toEqual([
      "Projects",
      "Projects",
      "Explore",
      "Manage",
      "Manage",
      "Manage",
      "Manage",
    ]);
    expect(findNavItem(projectManagementNavItems, "Users")).toMatchObject({
      url: "/access/users",
      pageLabel: "Users",
    });
    expect(findNavItem(projectManagementNavItems, "Website")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Marketplace")).toMatchObject({
      url: "/marketplace",
      pageLabel: "Marketplace",
    });
    const domains = projectManagementNavItems.find((item) => item.title === "Domains");
    expect(domains).toMatchObject({
      landingUrl: "/server/domains",
      pageLabel: "Domains",
    });
    expect(domains?.items?.map((item) => item.title)).toEqual([
      "Overview",
      "Add Domain",
      "Buy",
      "Transfer",
    ]);
    expect(findNavItem(projectManagementNavItems, "Add Domain")).toMatchObject({
      url: "/server/domains",
      search: { domainAction: "add" },
      pageLabel: "Add Domain",
    });
    expect(
      projectManagementNavItems
        .find((item) => item.title === "Server")
        ?.items?.some((item) => item.title === "Domains"),
    ).toBe(false);
    const resources = projectManagementNavItems.find((item) => item.title === "Resources");
    expect(resources).toMatchObject({
      landingUrl: "/resources",
      pageLabel: "Resources",
    });
    expect(resources?.items?.map((item) => item.title)).toEqual([
      "Overview",
      "Processes",
      "Storage",
      "Limits",
    ]);
    expect(findNavItem(projectManagementNavItems, "Processes")).toMatchObject({
      url: "/resources",
      search: { resourceView: "processes" },
      pageLabel: "Processes",
    });
    const security = projectManagementNavItems.find((item) => item.title === "Security");
    expect(security).toMatchObject({
      landingUrl: "/security",
      pageLabel: "Security",
    });
    expect(security?.items?.map((item) => item.title)).toEqual(["Checklist"]);
    expect(findNavItem(projectManagementNavItems, "Settings")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "New Project")).toBeUndefined();
  });

  it("renders database menu items supplied by the database service", () => {
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
              title: "Create Table",
              path: "/database/new",
              pageLabel: "Database",
              fixed: true,
              fixedOrder: 1,
            },
            {
              title: "audit_log",
              path: "/database",
              pageLabel: "Database",
              search: { databaseTable: "audit_log" },
            },
            {
              title: "fruits",
              path: "/database",
              pageLabel: "Database",
              search: { databaseTable: "fruits" },
            },
            {
              title: "System Tables",
              panelLabel: "System Tables",
              items: [
                {
                  title: "zv_collections",
                  path: "/database",
                  pageLabel: "Database",
                  search: { systemTable: "zv_collections" },
                },
                {
                  title: "zv_events",
                  path: "/database",
                  pageLabel: "Database",
                  search: { systemTable: "zv_events" },
                },
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
      "project-a",
    );

    const database = findNavItem(nav, "Database");
    expect(database?.items?.map((item) => item.title)).toEqual([
      "Create Table",
      "audit_log",
      "fruits",
      "System Tables",
    ]);
    expect(findNavItem(database?.items ?? [], "Create Table")).toMatchObject({
      url: "/projects/project-a/database/new",
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
    expect(findNavItem(nav, "Fruits")).toMatchObject({
      panelLabel: "Fruits",
      landingUrl: "/projects/project-a/content/fruits",
    });
    expect(findNavItem(database?.items ?? [], "fruits")?.search).toEqual({
      databaseTable: "fruits",
    });
    expect(findNavItem(database?.items ?? [], "audit_log")).toMatchObject({
      search: {
        databaseTable: "audit_log",
      },
    });
    expect(findNavItem(database?.items ?? [], "zv_collections")).toBeDefined();
  });
});
