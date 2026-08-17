import { describe, expect, it } from "vitest";
import {
  buildManagedProjectNavItems,
  buildPlatformNavItems,
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

    const nav = buildPlatformNavItems([], services);
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
    const settings = nav.find((item) => item.title === "Settings");
    expect(settings).toMatchObject({
      landingUrl: "/projects/default/settings",
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
      "Marketplace",
      "Domains",
      "Resources",
      "Server",
      "Security",
    ]);
    expect(projectManagementNavItems.map((item) => item.sectionLabel)).toEqual([
      "Projects",
      "Explore",
      "Manage",
      "Manage",
      "Manage",
      "Manage",
    ]);
    expect(findNavItem(projectManagementNavItems, "Users")).toBeUndefined();
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
    expect(findNavItem(nav, "Fruits")).toMatchObject({
      panelLabel: "Fruits",
      landingUrl: "/projects/default/content/fruits",
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
