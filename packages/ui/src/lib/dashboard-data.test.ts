import { describe, expect, it } from "vitest";
import {
  buildPlatformNavItems,
  buildWorkspacePluginNavItems,
  type DashboardNavItem,
} from "./dashboard-data";
import type { RuntimePluginRegistryEntry, RuntimeService } from "./runtime-api";

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
  it("keeps installed plugins to one root workspace item with nested slides underneath", () => {
    const plugins = [
      {
        name: "zelavis-ecommerce",
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
    ] satisfies readonly RuntimePluginRegistryEntry[];

    const workspaceItems = buildWorkspacePluginNavItems(plugins);
    expect(workspaceItems).toHaveLength(1);
    expect(workspaceItems[0]?.title).toBe("Ecommerce");
    expect(workspaceItems[0]?.items?.map((item) => item.title)).toEqual(["Orders"]);

    const nav = buildPlatformNavItems([], plugins);
    const workspace = nav.find((item) => item.title === "Workspace");
    expect(workspace?.items?.some((item) => item.title === "Ecommerce")).toBe(true);
    expect(nav.some((item) => item.title === "Ecommerce")).toBe(false);
  });

  it("allows core services to declare their dashboard surface explicitly", () => {
    const services = [
      {
        name: "insights",
        core: true,
        apiPath: "/api/v1/insights",
        menu: {
          title: "Insights",
          path: "/users",
          surface: "root",
        },
      },
      {
        name: "jobs",
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
