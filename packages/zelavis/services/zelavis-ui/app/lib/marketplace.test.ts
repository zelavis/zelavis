import { describe, expect, it } from "vitest";

import {
  marketplaceTabCounts,
  marketplaceTabDisabledReason,
  selectMarketplaceItems,
} from "./marketplace";
import type { RuntimeServiceRegistryEntry } from "./runtime-api";

const entry = (
  name: string,
  kind: string,
  overrides: Partial<RuntimeServiceRegistryEntry> = {},
): RuntimeServiceRegistryEntry => ({
  name,
  kind,
  status: "available",
  scope: "extension",
  ...overrides,
});

const registry: RuntimeServiceRegistryEntry[] = [
  entry("@zelavis/ui", "frontend", { scope: "system", status: "installed" }),
  entry("@zelavis/marketplace", "plugin", { scope: "system", status: "installed" }),
  entry("@zelavis/app", "app", {
    scope: "system",
    status: "installed",
    marketplace: { title: "Zelavis App", summary: "The official app stack", tags: ["official"] },
  }),
  entry("@zelavis/wordpress", "app", {
    marketplace: { title: "WordPress", summary: "A managed WordPress site", tags: ["cms", "php"] },
  }),
  entry("@zelavis/ecommerce", "plugin", { marketplace: { title: "Ecommerce" } }),
  entry("@acme/blog", "frontend", { marketplace: { title: "Blog" } }),
];

describe("marketplace tabs", () => {
  it("lists installable things per kind, and never the trusted runtime itself", () => {
    expect(selectMarketplaceItems(registry, "apps").map((item) => item.name)).toEqual([
      "@zelavis/app",
      "@zelavis/wordpress",
    ]);
    expect(selectMarketplaceItems(registry, "plugins").map((item) => item.name)).toEqual([
      "@zelavis/ecommerce",
    ]);
    // The dashboard's own frontend is system scope and is not offered.
    expect(selectMarketplaceItems(registry, "frontends").map((item) => item.name)).toEqual([
      "@acme/blog",
    ]);
  });

  it("puts installed entries first", () => {
    const [first] = selectMarketplaceItems(registry, "apps");
    expect(first.status).toBe("installed");
  });

  it("searches title, summary, name and tags", () => {
    expect(selectMarketplaceItems(registry, "apps", "php").map((item) => item.name)).toEqual([
      "@zelavis/wordpress",
    ]);
    expect(selectMarketplaceItems(registry, "apps", "OFFICIAL").map((item) => item.name)).toEqual([
      "@zelavis/app",
    ]);
    expect(selectMarketplaceItems(registry, "apps", "nothing like this")).toEqual([]);
  });

  it("counts each tab", () => {
    expect(marketplaceTabCounts(registry)).toEqual({ apps: 2, frontends: 1, plugins: 1 });
  });

  it("closes Frontends on the Platform only", () => {
    expect(marketplaceTabDisabledReason("frontends", "platform")).toMatch(/cannot be switched/);
    expect(marketplaceTabDisabledReason("frontends", "project")).toBeUndefined();
    expect(marketplaceTabDisabledReason("apps", "platform")).toBeUndefined();
    expect(marketplaceTabDisabledReason("plugins", "platform")).toBeUndefined();
  });
});
