import { defineService } from "@zelavis/server";

export const marketplaceService = defineService({
  name: "@zelavis/marketplace",
  version: "1.0.1-alpha.2",
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
