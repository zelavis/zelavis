import type { RuntimeServiceRegistryEntry } from "#/lib/runtime-api";

/**
 * The marketplace is one workspace in two places: the Platform's (`/marketplace`)
 * and a Project's (`/projects/:projectId/marketplace`). What differs is only
 * what the scope allows, never how it looks.
 */
export type MarketplaceScope = "platform" | "project";

export const MARKETPLACE_TABS = ["apps", "frontends", "plugins"] as const;
export type MarketplaceTab = (typeof MARKETPLACE_TABS)[number];

export const MARKETPLACE_TAB_LABELS: Record<MarketplaceTab, string> = {
  apps: "Apps",
  frontends: "Frontends",
  plugins: "Plugins",
};

const TAB_KIND: Record<MarketplaceTab, string> = {
  apps: "app",
  frontends: "frontend",
  plugins: "plugin",
};

/**
 * The Platform's own frontend is the dashboard. Switching it would let an
 * operator disable the official one, so the Frontends tab is closed there;
 * a Project chooses its own face freely.
 */
export function marketplaceTabDisabledReason(
  tab: MarketplaceTab,
  scope: MarketplaceScope,
): string | undefined {
  return tab === "frontends" && scope === "platform"
    ? "The Zelavis dashboard's own frontend cannot be switched, so it cannot be disabled by installing another. Open a Project's Marketplace to choose that Project's frontend."
    : undefined;
}

/** A trusted, host-composed package is part of the runtime, not something to shop for. */
function isOffered(service: RuntimeServiceRegistryEntry, tab: MarketplaceTab) {
  return service.kind === TAB_KIND[tab] && service.scope !== "system";
}

export function marketplaceTitle(service: RuntimeServiceRegistryEntry) {
  return service.marketplace?.title ?? service.menu?.title ?? service.name;
}

/** What a tab lists: installed first, then by declared order, then by name. */
export function selectMarketplaceItems(
  registry: readonly RuntimeServiceRegistryEntry[],
  tab: MarketplaceTab,
  query = "",
): RuntimeServiceRegistryEntry[] {
  const needle = query.trim().toLowerCase();
  return registry
    .filter((service) => (tab === "apps" ? service.kind === "app" : isOffered(service, tab)))
    .filter((service) => {
      if (!needle) return true;
      return [
        service.name,
        marketplaceTitle(service),
        service.marketplace?.summary,
        ...(service.marketplace?.tags ?? []),
        ...(service.marketplace?.categories ?? []),
      ]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLowerCase().includes(needle));
    })
    .sort(
      (left, right) =>
        Number(right.status === "installed") - Number(left.status === "installed") ||
        (left.order ?? 1_000) - (right.order ?? 1_000) ||
        marketplaceTitle(left).localeCompare(marketplaceTitle(right)),
    );
}

/** How many entries each tab holds, so a tab can say so before it is opened. */
export function marketplaceTabCounts(
  registry: readonly RuntimeServiceRegistryEntry[],
): Record<MarketplaceTab, number> {
  return {
    apps: selectMarketplaceItems(registry, "apps").length,
    frontends: selectMarketplaceItems(registry, "frontends").length,
    plugins: selectMarketplaceItems(registry, "plugins").length,
  };
}
