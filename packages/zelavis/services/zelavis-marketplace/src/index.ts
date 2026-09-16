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
 * The page is currently a placeholder rendered through the service page API,
 * which the dashboard mounts in a frame. A component library that lets a
 * service render natively is future work; until it exists, the frame is the
 * supported way for a service to own its own page.
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
    page: {
      id: "marketplace",
      title: "Marketplace",
      bundle: "dashboard",
      file: "marketplace.html",
    },
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
    page: {
      id: "project-marketplace",
      title: "Marketplace",
      bundle: "dashboard",
      file: "marketplace.html",
    },
    access: {
      permissions: ["project.marketplace.manage"],
      scope: { type: "project", projectIdParam: "projectId" },
    },
  });
}
