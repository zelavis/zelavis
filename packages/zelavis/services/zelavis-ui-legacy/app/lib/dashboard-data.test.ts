import { describe, expect, it } from "vitest";
import {
  buildManagedProjectNavItems,
  buildPlatformNavItems,
  buildProjectManagementNavItems,
  projectManagementNavItems,
  buildExtensionServiceNavItems,
  findServiceMenuContentByPath,
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

  it("does not copy trusted non-extension menus into Extensions", () => {
    const services = [
      {
        name: "zelavis/app",
        kind: "app",
        status: "installed",
        source: "official",
        menu: {
          title: "Overview",
          path: "/",
          surface: "root",
        },
      },
    ] satisfies readonly RuntimeServiceRegistryEntry[];

    expect(buildExtensionServiceNavItems(services)).toEqual([]);

    const nav = buildPlatformNavItems(
      [],
      services,
      undefined,
      undefined,
      "project-a",
    );
    const extensions = nav.find((item) => item.title === "Extensions");

    expect(extensions?.items?.map((item) => item.title)).toEqual(["Agents"]);
    expect(findNavItem(nav, "Overview")?.url).toBe("/projects/project-a");
  });

  it("lists the Project Overview once, even when a recipe declares its own", () => {
    // What a running Project reports about itself: its recipe's menu for the
    // Project's root page, which is the page the dashboard's own Overview opens.
    const services = [
      {
        name: "@zelavis/app",
        scope: "system",
        apiPath: "/zelavis/api/v1/plugins/app",
        menu: { title: "Overview", path: "/", surface: "root" },
        menus: [{ title: "Overview", path: "/", surface: "root" }],
      },
    ] as unknown as readonly RuntimeService[];

    const nav = buildPlatformNavItems(services, [], undefined, undefined, "project-a");

    expect(nav.filter((item) => item.title === "Overview")).toHaveLength(1);
    expect(findNavItem(nav, "Overview")?.url).toBe("/projects/project-a");
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
            file: "dashboard.html",
            src: "/zelavis/api/v1/runtime/service-page-assets/%40zelavis%2Fexample-plugin-basic/dist/dashboard.html",
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
        name: "zelavis/platform",
        scope: "system",
        apiPath: "/api/v1/runtime",
        menu: {
          title: "Server",
          path: "/server",
          pageLabel: "Server",
          sectionLabel: "Manage",
          order: 60,
          surface: "platform",
          access: {
            permissions: ["server.manage"],
            scope: { type: "system" },
          },
          items: [
            {
              title: "Overview",
              path: "/server",
              pageLabel: "Server",
            },
            {
              title: "Domains",
              path: "/server/domains",
              pageLabel: "Domains",
              items: [
                {
                  title: "Add Domain",
                  path: "/server/domains",
                  search: { domainAction: "add" },
                  pageLabel: "Add Domain",
                },
              ],
            },
            {
              title: "Access",
              path: "/server/access",
              pageLabel: "Access",
              panelLabel: "Access",
              access: {
                permissions: ["access.manage"],
                scope: { type: "system" },
              },
              items: [
                {
                  title: "Users",
                  path: "/server/access/users",
                  pageLabel: "Users",
                },
                {
                  title: "Permissions",
                  path: "/server/access/permissions",
                  pageLabel: "Permissions",
                },
              ],
            },
            {
              title: "Backups",
              path: "/server/backups",
              pageLabel: "Backups",
            },
            {
              title: "Logs",
              path: "/server/logs",
              pageLabel: "Logs",
            },
          ],
        },
      },
    ]);

    expect(nav.map((item) => item.title)).not.toContain("Access");
    expect(nav.map((item) => item.title)).toContain("Server");
    expect(findNavItem(nav, "Server")).toMatchObject({
      url: "/server",
      landingUrl: "/server",
      pageLabel: "Server",
      access: {
        permissions: ["server.manage"],
        scope: { type: "system" },
      },
    });
    expect(findNavItem(nav, "Domains")).toMatchObject({
      url: "/server/domains",
      landingUrl: "/server/domains",
      pageLabel: "Domains",
    });
    expect(findNavItem(nav, "Add Domain")).toMatchObject({
      url: "/server/domains",
      search: { domainAction: "add" },
      pageLabel: "Add Domain",
    });
    expect(findNavItem(nav, "Access")).toMatchObject({
      url: "/server/access",
      landingUrl: "/server/access",
      pageLabel: "Access",
      access: {
        permissions: ["access.manage"],
        scope: { type: "system" },
      },
    });
    expect(findNavItem(nav, "Users")).toMatchObject({
      url: "/server/access/users",
      pageLabel: "Users",
    });
    expect(findNavItem(nav, "Backups")).toMatchObject({
      url: "/server/backups",
      pageLabel: "Backups",
    });
  });

  it("exposes project Frontend and project-wide Media without the old Builder area", () => {
    const services = [
      {
        name: "@zelavis/frontend",
        apiPath: "/",
        menu: {
          title: "Frontend",
          path: "/frontend",
          pageLabel: "Frontend",
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
      ["Frontend", "Build"],
      ["Extensions", "Extend"],
      ["Backend", "Backend"],
      ["Settings", "Settings"],
    ]);
    expect(nav.some((item) => item.title === "Frontend")).toBe(true);
    expect(findNavItem(nav, "Frontend")).toMatchObject({
      url: "/projects/project-a/frontend",
      pageLabel: "Frontend",
      access: {
        permissions: ["project.website.manage"],
        scope: { type: "project", projectId: "project-a" },
      },
    });
    expect(findNavItem(nav, "Media")).toMatchObject({
      url: "/projects/project-a/media",
      pageLabel: "Media",
    });
    // The marketplace is a service now, not a dashboard route. It reaches
    // this nav only through the service registry.
    expect(findNavItem(nav, "Marketplace")).toBeUndefined();
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
    const nav = buildManagedProjectNavItems("wp", { adminTitle: "WordPress Admin" });

    expect(nav.map((item) => [item.title, item.sectionLabel])).toEqual([
      ["Overview", "Overview"],
      ["Domains", "Hosting"],
      ["Files", "Hosting"],
      ["App database", "Hosting"],
      ["Setup", "Hosting"],
      ["Backups", "Operations"],
      ["Logs", "Operations"],
      ["Updates", "Operations"],
      ["WordPress Admin", "Settings"],
    ]);
    expect(
      buildManagedProjectNavItems("app", {}).at(-1)?.title,
    ).toBe("App Admin");
  });

  it("renders and scopes live managed recipe menus beside hosting controls", () => {
    const service = { name: "@acme/wordpress", scope: "system" as const, namespace: "wordpress", kind: "app" as const,
      apiPath: "/proxy/zelavis/api/v1/wordpress", menus: [{ title: "Recipe v1", path: "/recipe", surface: "root" as const,
        page: { id: "recipe", src: "/proxy/page.html" } }] };
    const first = buildManagedProjectNavItems("wp", {}, [service]);
    expect(first.at(-1)).toMatchObject({ title: "Recipe v1", url: "/projects/wp/recipe", page: { src: "/proxy/page.html" } });
    const next = buildManagedProjectNavItems("wp", {}, [{ ...service, menus: [{ ...service.menus[0], title: "Recipe v2" }] }]);
    expect(next.some(item => item.title === "Recipe v1")).toBe(false);
    expect(next.at(-1)?.title).toBe("Recipe v2");
    expect(buildManagedProjectNavItems("wp", {}, [{ ...service, menus: [] }])).toHaveLength(9);
  });

  it("reveals the existing native sections only for used managed app APIs", () => {
    const available = { identity: { available: true, used: false }, database: { available: true, used: false },
      storage: { available: true, used: false }, workloads: { available: true, used: false } };
    const hidden = buildManagedProjectNavItems("wp", {}, [], available);
    expect(hidden.some(item => item.title === "Backend" || item.title === "Users")).toBe(false);
    const nav = buildManagedProjectNavItems("wp", {}, [], { ...available,
      identity: { available: true, used: true }, database: { available: true, used: true } });
    expect(nav.find(item => item.title === "Users")?.url).toBe("/projects/wp/users");
    expect(nav.find(item => item.title === "Content")?.landingUrl).toBe("/projects/wp/content");
    expect(nav.find(item => item.title === "Backend")?.items?.map(item => item.title)).toEqual(["Auth", "Database"]);
    expect(nav.some(item => item.title === "Media")).toBe(false);
    expect(nav.find(item => item.title === "App database")?.url).toBe("/projects/wp/app-database");
  });

  it("uses a management nav for the all-projects view", () => {
    expect(projectManagementNavItems.map((item) => item.title)).toEqual([
      "Projects",
    ]);
    expect(projectManagementNavItems.map((item) => item.sectionLabel)).toEqual([
      "Projects",
    ]);
    // Native Server navigation is contributed by the selected @zelavis/ui
    // package at runtime; this static export intentionally contains no fake
    // service fixture.
    expect(findNavItem(projectManagementNavItems, "Server")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Frontend")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Marketplace")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Settings")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "New Project")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "Settings")).toBeUndefined();
    expect(findNavItem(projectManagementNavItems, "New Project")).toBeUndefined();
  });

  it("renders database menu items supplied by the database service", () => {
    const services = [
      {
        name: "@zelavis/db",
        apiPath: "/api/v1/database",
        menu: {
          title: "Database",
          path: "/database",
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
      [],
      "project-a",
    );

    const database = findNavItem(nav, "Database");
    expect(database).toMatchObject({
      url: "/projects/project-a/database",
      landingUrl: "/projects/project-a/database",
    });
    expect(database?.items?.map((item) => item.title)).toEqual([
      "Create Table",
      "audit_log",
      "fruits",
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
  });

  it("gives workload parent slides canonical route targets", () => {
    const services = [
      {
        name: "@zelavis/workloads",
        apiPath: "/api/v1/workloads",
        menu: {
          title: "Workloads",
          path: "/workloads",
          surface: "core",
          panelLabel: "Workloads",
          items: [
            {
              title: "Functions",
              path: "/workloads/functions",
              panelLabel: "Functions",
              items: [
                {
                  title: "Add Function",
                  path: "/workloads/new",
                  pageLabel: "Workloads",
                  fixed: true,
                  fixedOrder: 1,
                },
              ],
            },
            {
              title: "Jobs",
              path: "/workloads/jobs",
              panelLabel: "Jobs",
              dynamicItems: {
                path: "/workloads/menu/jobs",
                emptyTitle: "No jobs yet",
              },
            },
          ],
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

    expect(findNavItem(nav, "Workloads")).toMatchObject({
      url: "/projects/project-a/workloads",
      landingUrl: "/projects/project-a/workloads",
    });
    expect(findNavItem(nav, "Functions")).toMatchObject({
      url: "/projects/project-a/workloads/functions",
      landingUrl: "/projects/project-a/workloads/functions",
    });
    expect(findNavItem(nav, "Jobs")).toMatchObject({
      url: "/projects/project-a/workloads/jobs",
      landingUrl: "/projects/project-a/workloads/jobs",
    });
  });

  it("derives dashboard paths for service menu items that forgot to declare content routes", () => {
    const services = [
      {
        name: "@zelavis/workloads",
        apiPath: "/api/v1/workloads",
        menu: {
          title: "Workloads",
          surface: "core",
          panelLabel: "Workloads",
          items: [
            {
              title: "Functions",
              panelLabel: "Functions",
              dynamicItems: {
                path: "/workloads/menu/functions",
                emptyTitle: "No functions yet",
              },
            },
          ],
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

    expect(findNavItem(nav, "Workloads")).toMatchObject({
      url: "/projects/project-a/workloads",
      landingUrl: "/projects/project-a/workloads",
    });
    expect(findNavItem(nav, "Functions")).toMatchObject({
      url: "/projects/project-a/workloads/functions",
      landingUrl: "/projects/project-a/workloads/functions",
    });
  });

  it("returns placeholder content for service menu parents without explicit pages", () => {
    const services = [
      {
        name: "@zelavis/workloads",
        apiPath: "/api/v1/workloads",
        menu: {
          title: "Workloads",
          path: "/workloads",
          surface: "core",
          panelLabel: "Workloads",
          items: [
            {
              title: "Functions",
              path: "/workloads/functions",
              panelLabel: "Functions",
              items: [
                {
                  title: "Add Function",
                  path: "/workloads/new",
                  fixed: true,
                },
              ],
            },
          ],
        },
      },
    ] satisfies readonly RuntimeService[];

    const rootContent = findServiceMenuContentByPath(
      "/projects/project-a/workloads",
      services,
      [],
    );
    const nestedContent = findServiceMenuContentByPath(
      "/projects/project-a/workloads/functions",
      services,
      [],
    );

    expect(rootContent).toMatchObject({
      kind: "placeholder",
      title: "Workloads",
    });
    expect(nestedContent).toMatchObject({
      kind: "placeholder",
      title: "Functions",
    });
  });

  it("finds iframe-backed service pages through generated menu paths", () => {
    const content = findServiceMenuPageByPath("/example-basic/dashboard", [
      {
        name: "@example/basic",
        status: "installed",
        menu: {
          title: "Dashboard",
          page: {
            id: "dashboard",
            file: "dashboard.html",
            src: "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fbasic/dist/dashboard.html",
          },
        },
      },
    ]);

    expect(content?.id).toBe("dashboard");
  });

  it("keeps dashboard paths separate from iframe page files", () => {
    const services = [
      {
        name: "@example/embedded",
        status: "installed",
        menu: {
          title: "Embedded",
          path: "/embedded",
          page: {
            id: "dashboard",
            file: "dashboard.html",
            src: "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fembedded/dist/dashboard.html",
          },
          items: [
            {
              title: "Settings",
              path: "/embedded/settings",
              page: {
                id: "settings",
                file: "settings.html",
                src: "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fembedded/dist/settings.html",
              },
            },
          ],
        },
      },
    ] satisfies readonly RuntimeServiceRegistryEntry[];

    const rootPage = findServiceMenuPageByPath("/embedded", services);
    const settingsPage = findServiceMenuPageByPath("/embedded/settings", services);

    expect(rootPage?.file).toBe("dashboard.html");
    expect(rootPage?.src).toBe(
      "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fembedded/dist/dashboard.html",
    );
    expect(settingsPage?.file).toBe("settings.html");
    expect(settingsPage?.src).toBe(
      "/zelavis/api/v1/runtime/service-page-assets/%40example%2Fembedded/dist/settings.html",
    );
  });
});

it("lists native and managed backend tables with their Tenant and separate system views", () => {
  const menus = [
    { title: "tenant-a · invoices", path: "/database", search: { databaseTenant: "tenant-a", databaseTable: "invoices" } },
    { title: "tenant-b · invoices", path: "/database", search: { databaseTenant: "tenant-b", databaseTable: "invoices" } },
    { title: "System · Events", path: "/database", search: { databaseTenant: "tenant-a", databaseSystemView: "events" } },
  ];
  const capabilities = { database: { available: true, used: true } };
  for (const nav of [buildPlatformNavItems([], [], [], menus, "app", capabilities),
    buildManagedProjectNavItems("app", {}, [], capabilities, [], menus)]) {
    const database = findNavItem(nav, "Database")!;
    expect(findNavItem(database.items ?? [], "tenant-a · invoices")).toMatchObject({
      url: "/projects/app/database", sectionLabel: "Tables", search: { databaseTenant: "tenant-a", databaseTable: "invoices" },
    });
    expect(findNavItem(database.items ?? [], "tenant-b · invoices")?.search?.databaseTenant).toBe("tenant-b");
    expect(findNavItem(database.items ?? [], "System Tables")?.items?.map(item => item.title)).toEqual(["Events"]);
  }
});
