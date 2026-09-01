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

import { MARKETPLACE_PAGE } from "./page.js";

export const ZELAVIS_MARKETPLACE_SERVICE_NAME = "@zelavis/marketplace";

/**
 * Installation-wide marketplace: apps, starters, templates, and server provider
 * plugins for the Platform as a whole.
 */
zelavis.menu.create({
  title: "Marketplace",
  path: "/marketplace",
  pageLabel: "Marketplace",
  sectionLabel: "Explore",
  order: 30,
  surface: "platform",
  page: {
    id: "marketplace",
    title: "Marketplace",
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
zelavis.menu.create({
  title: "Marketplace",
  path: "/marketplace",
  pageLabel: "Marketplace",
  sectionLabel: "Extend",
  surface: "root",
  page: {
    id: "project-marketplace",
    title: "Marketplace",
    file: "marketplace.html",
  },
  access: {
    permissions: ["project.marketplace.manage"],
    scope: { type: "project", projectIdParam: "projectId" },
  },
});

/**
 * What the SDK does not cover: identity, and the page bytes themselves.
 *
 * `zelavis.menu.create` declares that a page exists and where it lives; the
 * file has to come from somewhere, and for a service that ships inside the
 * Platform there is no package archive to unpack it from.
 */
export default {
  name: ZELAVIS_MARKETPLACE_SERVICE_NAME,
  basePath: "/marketplace",
  capabilities: ["dashboard:menu", "marketplace:services"] as const,
  pageAssets: {
    "marketplace.html": {
      contentType: "text/html; charset=utf-8",
      body: MARKETPLACE_PAGE,
    },
  },
  api: {},
  service: {},
};
