/**
 * Official Zelavis marketplace.
 *
 * A first-party product service built the same way a third-party one is: a
 * `package.json` manifest declaring `zelavis.kind`, and a module that calls the
 * official SDK. Nothing here is privileged, and nothing about it is known to
 * the dashboard — it contributes its menus and its page through the same
 * extension points any plugin uses.
 *
 * That is the point of shipping it this way. If a first-party service needs a
 * private path into the dashboard, the extension mechanism is not finished; if
 * it does not, the mechanism is proven by the product itself.
 *
 * Its pages ship in `@zelavis/ui` (a core service with content already in the
 * dashboard uses `menu.path` with no `menu.page`): one workspace serves both the
 * Platform's marketplace and a Project's, so the two cannot drift apart.
 */
import { zelavis } from "zelavis/sdk";

/**
 * Installation-wide marketplace: Project recipes presented as apps and
 * starters, plus templates and server provider plugins for the Platform as a
 * whole.
 */
export function register() {
  zelavis.plugins.ui.menus.create({
    title: "Marketplace",
    path: "/marketplace",
    pageLabel: "Marketplace",
    sectionLabel: "Explore",
    order: 30,
    surface: "platform",
    access: {
      permissions: ["marketplace.view"],
      scope: { type: "system" },
    },
  });

  /**
   * Project-scoped marketplace: plugins and services installed into one Project.
   *
   * A separate contribution rather than a variant of the one above — a different
   * surface, a different permission, and a different catalogue.
   */
  zelavis.plugins.ui.menus.create({
    title: "Marketplace",
    path: "/marketplace",
    pageLabel: "Marketplace",
    sectionLabel: "Extend",
    surface: "root",
    access: {
      permissions: ["project.marketplace.manage"],
      scope: { type: "project", projectIdParam: "projectId" },
    },
  });
}
