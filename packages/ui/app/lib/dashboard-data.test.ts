import { describe, expect, it } from "vitest";
import {
  buildPlatformNavItems,
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
});
