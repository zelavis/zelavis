import {
  Bot,
  Boxes,
  CreditCard,
  Database,
  Files,
  FileText,
  Fingerprint,
  Github,
  LayoutDashboard,
  LifeBuoy,
  MonitorCog,
  Paintbrush,
  PanelsTopLeft,
  Package,
  Pencil,
  ReceiptText,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  ShoppingBag,
  Store,
  TicketPercent,
  Users,
  type LucideIcon,
} from "lucide-react";
import type {
  RuntimePluginMenuDefinition,
  RuntimePluginRegistryEntry,
} from "#/lib/runtime-api";
import type { ContentTypeRow } from "#/lib/content-studio";

export type DashboardRoutePath =
  | "/"
  | "/agents"
  | "/auth"
  | "/builder"
  | "/builder/pages"
  | "/commerce"
  | "/commerce/customers"
  | "/commerce/coupons"
  | "/commerce/orders"
  | "/commerce/products"
  | "/content"
  | "/content/new"
  | `/content/${string}`
  | `/content/${string}/edit`
  | `/content/${string}/fields`
  | `/content/${string}/settings`
  | "/database"
  | "/media"
  | "/marketplace"
  | "/services"
  | "/settings"
  | "/settings/appearance"
  | "/storage"
  | "/users";

export type DashboardNavSearch = {
  table?: string;
  systemTable?:
    | "_collections"
    | "_documents"
    | "_events"
    | "_schemas"
    | "_time_series_checkpoints"
    | "_time_series_points";
  sidebar?: string;
};

export type DashboardNavItem = {
  title: string;
  url?: DashboardRoutePath;
  search?: DashboardNavSearch;
  icon: LucideIcon;
  pageLabel?: string;
  pluginOwned?: boolean;
  items?: readonly DashboardNavItem[];
};

export type DashboardPackageItem = {
  name: string;
  url?: DashboardRoutePath;
  icon: LucideIcon;
  pageLabel?: string;
};

export type DashboardPluginMenuItem = {
  title: string;
  url?: DashboardRoutePath;
  search?: DashboardNavSearch;
  icon: LucideIcon;
  pageLabel?: string;
  pluginOwned?: boolean;
  items?: readonly DashboardPluginMenuItem[];
};

export type DashboardWorkspacePluginItem = {
  id: string;
  name: string;
  menu: DashboardPluginMenuItem;
  status: "installed" | "available";
  source?: "official" | "community";
};

export type DashboardSecondaryItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  external?: boolean;
};

export type DashboardTeamItem = {
  name: string;
  logo: LucideIcon;
  plan: string;
};

export const sidebarTeams: readonly DashboardTeamItem[] = [
  {
    name: "Zelavis",
    logo: Server,
    plan: "Runtime",
  },
  {
    name: "Local",
    logo: MonitorCog,
    plan: "Development",
  },
  {
    name: "Core",
    logo: Database,
    plan: "Services",
  },
] as const;

const dashboardRoutePaths = new Set<DashboardRoutePath>([
  "/",
  "/agents",
  "/auth",
  "/builder",
  "/builder/pages",
  "/commerce",
  "/commerce/customers",
  "/commerce/coupons",
  "/commerce/orders",
  "/commerce/products",
  "/content",
  "/content/new",
  "/database",
  "/media",
  "/marketplace",
  "/services",
  "/settings",
  "/settings/appearance",
  "/storage",
  "/users",
]);

function toDashboardRoutePath(path: string): DashboardRoutePath | undefined {
  return dashboardRoutePaths.has(path as DashboardRoutePath)
    ? (path as DashboardRoutePath)
    : undefined;
}

function slugifyPluginName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getPluginMenuIcon(title: string, path?: string): LucideIcon {
  switch (path) {
    case "/commerce":
      return Store;
    case "/commerce/products":
      return ShoppingBag;
    case "/commerce/orders":
      return ReceiptText;
    case "/commerce/customers":
      return Users;
    case "/commerce/coupons":
      return TicketPercent;
    default:
      break;
  }

  switch (title.toLowerCase()) {
    case "ecommerce":
      return Store;
    case "products":
      return ShoppingBag;
    case "orders":
      return ReceiptText;
    case "customers":
      return Users;
    case "coupons":
      return TicketPercent;
    case "more":
      return Package;
    default:
      return Package;
  }
}

function createDashboardPluginMenuItem(
  menu: RuntimePluginMenuDefinition,
): DashboardPluginMenuItem {
  return {
    title: menu.title,
    url: menu.path ? toDashboardRoutePath(menu.path) : undefined,
    icon: getPluginMenuIcon(menu.title, menu.path),
    pageLabel: menu.pageLabel,
    pluginOwned: true,
    items: menu.items?.map(createDashboardPluginMenuItem),
  };
}

export function buildDashboardPluginRegistryEntries(
  plugins?: readonly RuntimePluginRegistryEntry[],
): readonly DashboardWorkspacePluginItem[] {
  return [...(plugins ?? [])]
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.name.localeCompare(right.name)
    })
    .flatMap((plugin) =>
    plugin.menu
      ? [
          {
            id: slugifyPluginName(plugin.name),
            name: plugin.name,
            status: plugin.status,
            source: plugin.source,
            menu: createDashboardPluginMenuItem(plugin.menu),
          },
        ]
      : [],
  )
}

const defaultRuntimePluginRegistry = [
  {
    name: "zelavis-ecommerce",
    version: "0.1.0",
    status: "available",
    source: "official",
    menu: {
      title: "Ecommerce",
      path: "/commerce",
      pageLabel: "Commerce",
      items: [
        {
          title: "Products",
          path: "/commerce/products",
        },
        {
          title: "Orders",
          path: "/commerce/orders",
        },
        {
          title: "More",
          items: [
            {
              title: "Customers",
              path: "/commerce/customers",
            },
            {
              title: "Coupons",
              path: "/commerce/coupons",
            },
          ],
        },
      ],
    },
  },
] as const satisfies readonly RuntimePluginRegistryEntry[];

export const dashboardPluginRegistryEntries =
  buildDashboardPluginRegistryEntries(defaultRuntimePluginRegistry);

export function buildWorkspacePluginNavItems(
  plugins?: readonly RuntimePluginRegistryEntry[],
): readonly DashboardPluginMenuItem[] {
  return buildDashboardPluginRegistryEntries(plugins)
    .filter((plugin) => plugin.status === "installed")
    .map((plugin) => plugin.menu);
}

export const workspacePluginNavItems =
  buildWorkspacePluginNavItems(defaultRuntimePluginRegistry);

export function buildPlatformNavItems(
  plugins?: readonly RuntimePluginRegistryEntry[],
  databaseCollections?: readonly { name: string }[],
  contentTypes?: readonly ContentTypeRow[],
): readonly DashboardNavItem[] {
  const pluginNavItems = buildWorkspacePluginNavItems(plugins);
  const databaseItems =
    [
      ...(databaseCollections && databaseCollections.length > 0
        ? databaseCollections.map((collection) => ({
            title: collection.name,
            url: "/database" as const,
            search: { table: collection.name },
            icon: Database,
            pageLabel: "Database",
          }))
        : [
            {
              title: "Tables",
              url: "/database" as const,
              icon: Database,
              pageLabel: "Database",
            },
          ]),
      {
        title: "System Tables",
        icon: Server,
        items: [
          {
            title: "_collections",
            url: "/database" as const,
            search: { systemTable: "_collections" },
            icon: Database,
            pageLabel: "Database",
          },
          {
            title: "_documents",
            url: "/database" as const,
            search: { systemTable: "_documents" },
            icon: Database,
            pageLabel: "Database",
          },
          {
            title: "_events",
            url: "/database" as const,
            search: { systemTable: "_events" },
            icon: Database,
            pageLabel: "Database",
          },
          {
            title: "_schemas",
            url: "/database" as const,
            search: { systemTable: "_schemas" },
            icon: Database,
            pageLabel: "Database",
          },
          {
            title: "_time_series_checkpoints",
            url: "/database" as const,
            search: { systemTable: "_time_series_checkpoints" },
            icon: Database,
            pageLabel: "Database",
          },
          {
            title: "_time_series_points",
            url: "/database" as const,
            search: { systemTable: "_time_series_points" },
            icon: Database,
            pageLabel: "Database",
          },
        ],
      },
    ] as const;
  const contentItems: readonly DashboardNavItem[] = [
    {
      title: "All Content Types",
      url: "/content",
      icon: FileText,
      pageLabel: "Content",
    },
    {
      title: "Add Content Type",
      url: "/content/new",
      icon: Package,
      pageLabel: "Content",
    },
    ...((contentTypes ?? []).map((contentType) => ({
      title: contentType.label,
      icon: FileText,
      items: [
        {
          title: "Entries",
          url: `/content/${contentType.name}` as DashboardRoutePath,
          icon: FileText,
          pageLabel: "Content",
        },
        {
          title: "Fields",
          url: `/content/${contentType.name}/fields` as DashboardRoutePath,
          icon: Package,
          pageLabel: "Content",
        },
        {
          title: "Type Editor",
          url: `/content/${contentType.name}/edit` as DashboardRoutePath,
          icon: Pencil,
          pageLabel: "Content",
        },
        {
          title: "Type Settings",
          url: `/content/${contentType.name}/settings` as DashboardRoutePath,
          icon: Settings2,
          pageLabel: "Content",
        },
      ],
    })) as readonly DashboardNavItem[]),
  ];

  return [
    {
      title: "Overview",
      url: "/",
      icon: LayoutDashboard,
    },
    {
      title: "Users",
      url: "/users",
      icon: Users,
    },
    {
      title: "Content",
      icon: FileText,
      items: contentItems,
    },
    {
      title: "Media Gallery",
      url: "/media",
      icon: Files,
      pageLabel: "Media",
    },
    {
      title: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
    },
    {
      title: "Core",
      icon: Server,
      items: [
        {
          title: "Auth",
          url: "/auth",
          icon: Fingerprint,
        },
        {
          title: "Database",
          icon: Database,
          items: databaseItems,
        },
        {
          title: "Storage",
          url: "/storage",
          icon: Files,
        },
      ],
    },
    {
      title: "Workspace",
      icon: Bot,
      items: [
        {
          title: "Agents",
          url: "/agents",
          icon: Bot,
        },
        {
          title: "Builder",
          icon: PanelsTopLeft,
          items: [
            {
              title: "Pages",
              url: "/builder/pages",
              icon: FileText,
              pageLabel: "Builder",
            },
          ],
        },
        ...pluginNavItems,
      ],
    },
    {
      title: "Settings",
      icon: Settings2,
      items: [
        {
          title: "Runtime",
          url: "/settings",
          icon: MonitorCog,
          pageLabel: "Settings",
        },
        {
          title: "Services",
          url: "/services",
          icon: Server,
        },
        {
          title: "Appearance",
          url: "/settings/appearance",
          icon: Paintbrush,
        },
      ],
    },
  ] as const;
}

export const platformNavItems = buildPlatformNavItems(
  defaultRuntimePluginRegistry,
);

export function buildMarketplacePackageItems(
  plugins?: readonly RuntimePluginRegistryEntry[],
): readonly DashboardPackageItem[] {
  const registryEntries = buildDashboardPluginRegistryEntries(plugins);

  return [
    {
      name: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
      pageLabel: "Marketplace",
    },
    ...registryEntries.map((plugin) => ({
      name: plugin.name,
      url: plugin.status === "installed" ? plugin.menu.url : undefined,
      icon: plugin.menu.icon ?? Package,
      pageLabel: plugin.menu.pageLabel,
    })),
  ] as const;
}

export const marketplacePackageItems = buildMarketplacePackageItems(
  defaultRuntimePluginRegistry,
);

export const secondaryNavItems: readonly DashboardSecondaryItem[] = [
  {
    title: "GitHub",
    url: "https://github.com/zelavis/zelavis",
    icon: Github,
    external: true,
  },
  {
    title: "Support",
    url: "https://github.com/zelavis/zelavis/discussions",
    icon: LifeBuoy,
    external: true,
  },
  {
    title: "Feedback",
    url: "https://github.com/zelavis/zelavis/issues/new",
    icon: Send,
    external: true,
  },
] as const;

function flattenPlatformItems(
  items: readonly DashboardNavItem[],
): Array<{ to: DashboardRoutePath; label: string; icon: LucideIcon }> {
  return items.flatMap((item) => [
    ...(item.url
      ? [{ to: item.url, label: item.pageLabel ?? item.title, icon: item.icon }]
      : []),
    ...flattenPlatformItems(item.items ?? []),
  ]);
}

export function buildDashboardNavItems(
  plugins?: readonly RuntimePluginRegistryEntry[],
) {
  return [
    ...flattenPlatformItems(buildPlatformNavItems(plugins)),
    ...buildMarketplacePackageItems(plugins)
      .filter(
        (item): item is DashboardPackageItem & { url: DashboardRoutePath } =>
          Boolean(item.url),
      )
      .map((item) => ({
        to: item.url,
        label: item.pageLabel ?? item.name,
        icon: item.icon,
      })),
  ] as const;
}

export const dashboardNavItems = buildDashboardNavItems(
  defaultRuntimePluginRegistry,
);

export function getDashboardPageLabel(
  pathname: string,
  plugins?: readonly RuntimePluginRegistryEntry[],
) {
  if (pathname.startsWith("/database/")) {
    return "Database";
  }

  return (
    buildDashboardNavItems(plugins).find((item) => item.to === pathname)
      ?.label ?? "Not Found"
  );
}

export const serviceRows = [
  {
    name: "dashboard",
    path: "/zelavis",
    state: "ready",
    scope: "core",
  },
  {
    name: "auth",
    path: "/zelavis/api/v1/auth",
    state: "ready",
    scope: "core",
  },
  {
    name: "database",
    path: "/zelavis/api/v1/database",
    state: "ready",
    scope: "core",
  },
  {
    name: "ecommerce",
    path: "marketplace package",
    state: "planned",
    scope: "official",
  },
] as const;

export const activityRows = [
  {
    label: "Core services mounted",
    detail: "dashboard, auth, database",
    time: "now",
  },
  {
    label: "Document database online",
    detail: "in-memory development driver",
    time: "now",
  },
  {
    label: "Dashboard assets served",
    detail: "/assets/* below the configured root",
    time: "build",
  },
] as const;

export const capabilityCards = [
  {
    title: "Auth",
    value: "2 providers",
    icon: ShieldCheck,
    detail: "email and username plugins ready for registration",
  },
  {
    title: "Database",
    value: "document + sql",
    icon: Database,
    detail: "document operations with optional SQL capability",
  },
  {
    title: "Payments",
    value: "provider plugins",
    icon: CreditCard,
    detail: "Stripe and PayPal boundaries are package-level plugins",
  },
] as const;
