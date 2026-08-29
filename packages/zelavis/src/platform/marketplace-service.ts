import type { ZelavisRuntimeService } from "../core/index.js";
import { ZELAVIS_VERSION } from "../version.js";

export const marketplaceService: ZelavisRuntimeService<Record<string, never>> & {
  version?: string;
  kind?: string;
  capabilities?: readonly string[];
} = Object.freeze({
  name: "zelavis/marketplace",
  version: ZELAVIS_VERSION,
  kind: "core",
  capabilities: Object.freeze(["dashboard:menu", "marketplace:services"]),
  basePath: "/marketplace",
  api: {},
  menu: Object.freeze({
    title: "Marketplace",
    path: "/marketplace",
    pageLabel: "Marketplace",
    sectionLabel: "Explore",
    order: 30,
    surface: "platform" as const,
    access: {
      permissions: ["marketplace.view"],
      scope: { type: "system" as const },
    },
  }),
  service: Object.freeze({}),
});

export default marketplaceService;
