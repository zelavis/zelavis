import { defineService } from "../core/index.js";
import { ZELAVIS_VERSION } from "../version.js";

export const marketplaceService = defineService({
  name: "zelavis/marketplace",
  version: ZELAVIS_VERSION,
  kind: "core",
  capabilities: ["dashboard:menu", "marketplace:services"],
  basePath: "/marketplace",
  menu: {
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
  },
  service: Object.freeze({}),
});

export default marketplaceService;
