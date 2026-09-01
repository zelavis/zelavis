/**
 * Marketplace service.
 *
 * Lives with the pages it describes. The marketplace is a Zelavis product
 * surface — a menu entry and the dashboard routes behind it — rather than
 * Platform control-plane behaviour, and keeping the definition beside
 * `routes/marketplace.tsx` is what stops the menu being described in one place
 * and rendered from a copy in another.
 */

export const ZELAVIS_MARKETPLACE_SERVICE_NAME = "zelavis/marketplace";

/**
 * Platform-level marketplace: apps, starters, templates, and server provider
 * plugins for the installation as a whole.
 */
export const zelavisMarketplaceMenu = Object.freeze({
  title: "Marketplace",
  path: "/marketplace",
  pageLabel: "Marketplace",
  sectionLabel: "Explore",
  order: 30,
  surface: "platform" as const,
  access: Object.freeze({
    permissions: Object.freeze(["marketplace.view"]),
    scope: Object.freeze({ type: "system" as const }),
  }),
});

/**
 * Project-level marketplace: plugins and services installed into one Project.
 *
 * A separate contribution rather than a variant of the platform menu, because
 * it is a different surface with a different permission. It was previously a
 * literal in the dashboard's navigation builder, backed by no service at all.
 */
export const zelavisProjectMarketplaceMenu = Object.freeze({
  title: "Marketplace",
  path: "/marketplace",
  pageLabel: "Marketplace",
  sectionLabel: "Extend",
  surface: "root" as const,
  access: Object.freeze({
    permissions: Object.freeze(["project.marketplace.manage"]),
    scope: Object.freeze({
      type: "project" as const,
      projectIdParam: "projectId",
    }),
  }),
});

export interface CreateZelavisMarketplaceServiceOptions {
  readonly version?: string;
}

/**
 * Builds the marketplace runtime service.
 *
 * Menu metadata only: the marketplace has no routes of its own, and the
 * catalogue it lists is served by the Platform's own service endpoints.
 */
export function createZelavisMarketplaceService(
  options: CreateZelavisMarketplaceServiceOptions = {},
) {
  return Object.freeze({
    name: ZELAVIS_MARKETPLACE_SERVICE_NAME,
    ...(options.version ? { version: options.version } : {}),
    kind: "core" as const,
    capabilities: Object.freeze(["dashboard:menu", "marketplace:services"]),
    basePath: "/marketplace",
    api: {},
    menu: zelavisMarketplaceMenu,
    service: Object.freeze({}),
  });
}
