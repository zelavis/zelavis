import {
  type ZelavisRuntimeService,
  type ZelavisServerRoute,
  type ZelavisServiceMenuDefinition,
} from "../core/index.js";
import { ZELAVIS_VERSION } from "../version.js";

export const zelavisCoreMenu = {
  title: "Server",
  path: "/server",
  pageLabel: "Server",
  sectionLabel: "Manage",
  order: 60,
  surface: "platform",
  access: {
    permissions: ["server.manage"],
    scope: { type: "system" },
  },
  items: [
    {
      title: "Overview",
      path: "/server",
      pageLabel: "Server",
    },
    {
      title: "Domains",
      path: "/server/domains",
      pageLabel: "Domains",
      panelLabel: "Domains",
      access: {
        permissions: ["server.domains.view"],
        scope: { type: "system" },
      },
      items: [
        {
          title: "Overview",
          path: "/server/domains",
          pageLabel: "Domains",
        },
        {
          title: "Add Domain",
          path: "/server/domains",
          search: { domainAction: "add" },
          pageLabel: "Add Domain",
        },
        {
          title: "Buy",
          path: "/server/domains",
          search: { domainAction: "buy" },
          pageLabel: "Buy Domain",
        },
        {
          title: "Transfer",
          path: "/server/domains",
          search: { domainAction: "transfer" },
          pageLabel: "Transfer Domain",
        },
      ],
    },
    {
      title: "Access",
      path: "/server/access",
      pageLabel: "Access",
      panelLabel: "Access",
      access: {
        permissions: ["access.manage"],
        scope: { type: "system" },
      },
      items: [
        {
          title: "Overview",
          path: "/server/access",
          pageLabel: "Access",
        },
        {
          title: "Users",
          path: "/server/access/users",
          pageLabel: "Users",
        },
        {
          title: "Permissions",
          path: "/server/access/permissions",
          pageLabel: "Permissions",
        },
      ],
    },
    {
      title: "Backups",
      path: "/server/backups",
      pageLabel: "Backups",
    },
    {
      title: "Logs",
      path: "/server/logs",
      pageLabel: "Logs",
    },
  ],
} as const satisfies ZelavisServiceMenuDefinition;

export interface ZelavisCoreServiceOptions<TService> {
  readonly service: TService;
  readonly routes: readonly ZelavisServerRoute<TService>[];
}

export function createZelavisCoreService<TService>(
  options: ZelavisCoreServiceOptions<TService>,
): ZelavisRuntimeService<TService> {
  return Object.freeze({
    name: "zelavis/platform",
    version: ZELAVIS_VERSION,
    kind: "core",
    capabilities: Object.freeze(["api:routes", "dashboard:menu", "platform:control-plane"]),
    basePath: "/runtime",
    menu: zelavisCoreMenu,
    service: options.service,
    api: {
      v1: options.routes,
    },
  });
}
