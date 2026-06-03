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
  Plus,
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
import { ZelavisMark } from "#/components/zelavis-mark";
import type {
  DatabaseCollection,
  RuntimeService,
  RuntimeServiceMenuDefinition,
  RuntimeServicePageDefinition,
  RuntimeServiceRegistryMenuDefinition,
  RuntimeServiceRegistryEntry,
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
  | "/database/new"
  | "/media"
  | "/marketplace"
  | "/services"
  | "/settings"
  | "/settings/appearance"
  | "/storage"
  | "/users"
  | `/${string}`;

export type DashboardNavSearch = {
  systemTable?:
    | "_collections"
    | "_events"
    | "_schemas"
    | "_time_series_checkpoints"
    | "_time_series_points";
  databaseTable?: string;
  sidebar?: string;
};

export type DashboardNavItem = {
  title: string;
  url?: DashboardRoutePath;
  /** Canonical landing page navigated to when this panel section is opened from the root. */
  landingUrl?: DashboardRoutePath;
  search?: DashboardNavSearch;
  icon: LucideIcon;
  panelLabel?: string;
  pageLabel?: string;
  fixed?: boolean;
  fixedOrder?: number;
  sectionLabel?: string;
  serviceOwned?: boolean;
  items?: readonly DashboardNavItem[];
};

export type DashboardPackageItem = {
  name: string;
  url?: DashboardRoutePath;
  icon: LucideIcon;
  pageLabel?: string;
};

export type DashboardServiceRegistryMenuItem = {
  title: string;
  url?: DashboardRoutePath;
  search?: DashboardNavSearch;
  icon: LucideIcon;
  panelLabel?: string;
  pageLabel?: string;
  fixed?: boolean;
  fixedOrder?: number;
  sectionLabel?: string;
  page?: RuntimeServicePageDefinition;
  serviceOwned?: boolean;
  items?: readonly DashboardServiceRegistryMenuItem[];
};

export type DashboardWorkspaceServiceItem = {
  id: string;
  name: string;
  menu: DashboardServiceRegistryMenuItem;
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
    logo: ZelavisMark,
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

function toDashboardRoutePath(path: string): DashboardRoutePath | undefined {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return undefined;
  }

  return path as DashboardRoutePath;
}

function slugifyServiceName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getServiceRegistryMenuIcon(title: string, path?: string): LucideIcon {
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

function createDashboardServiceRegistryMenuItem(
  menu: RuntimeServiceRegistryMenuDefinition,
): DashboardServiceRegistryMenuItem {
  return {
    title: menu.title,
    url: menu.path ? toDashboardRoutePath(menu.path) : undefined,
    icon: getServiceRegistryMenuIcon(menu.title, menu.path),
    pageLabel: menu.pageLabel,
    panelLabel: menu.panelLabel,
    fixed: menu.fixed,
    fixedOrder: menu.fixedOrder,
    sectionLabel: menu.sectionLabel,
    page: menu.page,
    serviceOwned: true,
    items: menu.items?.map(createDashboardServiceRegistryMenuItem),
  };
}

function getServiceMenuIcon(title: string, serviceName?: string): LucideIcon {
  switch (serviceName ?? title.toLowerCase()) {
    case "@zelavis/auth":
      return Fingerprint;
    case "@zelavis/db":
      return Database;
    case "@zelavis/storage":
      return Files;
    case "@zelavis/website":
      return PanelsTopLeft;
    default:
      return Server;
  }
}

function createDashboardServiceMenuItem(
  menu: RuntimeServiceMenuDefinition,
  serviceName?: string,
): DashboardNavItem {
  return {
    title: menu.title,
    url: menu.path ? toDashboardRoutePath(menu.path) : undefined,
    icon: getServiceMenuIcon(menu.title, serviceName),
    pageLabel: menu.pageLabel,
    panelLabel: menu.panelLabel,
    fixed: menu.fixed,
    fixedOrder: menu.fixedOrder,
    sectionLabel: menu.sectionLabel,
    items: menu.items?.map((item) => createDashboardServiceMenuItem(item, serviceName)),
  };
}

type DashboardServiceSurface = NonNullable<RuntimeServiceMenuDefinition["surface"]>;

function getServiceMenuSurface(service: RuntimeService): DashboardServiceSurface {
  return service.menu?.surface ?? "core";
}

export function buildDashboardServiceRegistryEntries(
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): readonly DashboardWorkspaceServiceItem[] {
  return [...(serviceRegistry ?? [])]
    .sort((left, right) => {
      const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.name.localeCompare(right.name)
    })
    .flatMap((service) =>
    service.menu
      ? [
          {
            id: slugifyServiceName(service.name),
            name: service.name,
            status: service.status,
            source: service.source,
            menu: createDashboardServiceRegistryMenuItem(service.menu),
          },
        ]
      : [],
  )
}

const defaultRuntimeServiceRegistry = [
  {
    name: "@zelavis/ecommerce",
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
] as const satisfies readonly RuntimeServiceRegistryEntry[];

export const dashboardServiceRegistryEntries =
  buildDashboardServiceRegistryEntries(defaultRuntimeServiceRegistry);

export function buildWorkspaceServiceNavItems(
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): readonly DashboardServiceRegistryMenuItem[] {
  // Installable services intentionally get exactly one root workspace area.
  // Any nested navigation must live under that one root item so first-slide
  // ownership stays reserved for built-in product surfaces and core services.
  return buildDashboardServiceRegistryEntries(serviceRegistry)
    .filter((service) => service.status === "installed")
    .map((service) => service.menu);
}

export const workspaceServiceNavItems =
  buildWorkspaceServiceNavItems(defaultRuntimeServiceRegistry);

const defaultRuntimeServices: readonly RuntimeService[] = [
  {
    name: "@zelavis/ui",
    core: true,
    apiPath: "/",
    menu: {
      title: "Dashboard",
      path: "/",
    },
  },
  {
    name: "@zelavis/auth",
    core: true,
    apiPath: "/api/v1/auth",
    menu: {
      title: "Auth",
      path: "/auth",
    },
  },
  {
    name: "@zelavis/db",
    core: true,
    apiPath: "/api/v1/database",
    menu: {
      title: "Database",
      panelLabel: "Database",
      items: [
        {
          title: "System Tables",
          panelLabel: "System Tables",
          items: [
            { title: "_collections", path: "/database" },
            { title: "_events", path: "/database" },
            { title: "_schemas", path: "/database" },
            { title: "_time_series_checkpoints", path: "/database" },
            { title: "_time_series_points", path: "/database" },
          ],
        },
      ],
    },
  },
  {
    name: "@zelavis/storage",
    core: true,
    apiPath: "/api/v1/storage",
    menu: {
      title: "Storage",
      path: "/storage",
    },
  },
  {
    name: "@zelavis/website",
    core: true,
    apiPath: "/",
    menu: {
      title: "Website",
      path: "/builder/pages",
      pageLabel: "Builder",
    },
  },
] as const;

export function buildPlatformNavItems(
  services?: readonly RuntimeService[],
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
  contentTypes?: readonly ContentTypeRow[],
  databaseCollections?: readonly DatabaseCollection[],
): readonly DashboardNavItem[] {
  const workspaceRegistryNavItems = buildWorkspaceServiceNavItems(serviceRegistry);
  const contentTypesByName = new Map(
    (contentTypes ?? []).map((contentType) => [contentType.name, contentType]),
  );
  const databaseTableItems = [...(databaseCollections ?? [])]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((collection) => {
      const contentType = contentTypesByName.get(collection.name);
      return {
        title: contentType?.label ?? collection.name,
        url: "/database" as const,
        search: { databaseTable: collection.name, systemTable: undefined },
        icon: Database,
        pageLabel: "Database",
        sectionLabel: "Tables",
      };
    });
  const serviceNavItems = (services ?? [])
    .filter((service) => service.core && service.name !== "@zelavis/ui")
    .map((service) => {
      const baseMenu = service.menu
        ? createDashboardServiceMenuItem(service.menu, service.name)
        : {
            title: service.name,
            icon: getServiceMenuIcon(service.name, service.name),
          };

      if (service.name !== "@zelavis/db") {
        return {
          item: baseMenu,
          surface: getServiceMenuSurface(service),
        };
      }

      const systemTableItems =
        baseMenu.items?.find((item) => item.title === "System Tables")?.items ?? [];

      return {
        item: {
          ...baseMenu,
          panelLabel: "Database",
          items: [
            {
              title: "Create Table",
              url: "/database/new" as const,
              icon: Plus,
              pageLabel: "Database",
              fixed: true,
              fixedOrder: 1,
            },
            ...databaseTableItems,
            ...(systemTableItems.length > 0
              ? [
                  {
                    title: "System Tables",
                    icon: Server,
                    panelLabel: "System Tables",
                    items: systemTableItems.map((item) => ({
                      ...item,
                      url: "/database" as const,
                      search: {
                        systemTable: item.title as DashboardNavSearch["systemTable"],
                        databaseTable: undefined,
                      },
                      icon: Database,
                      pageLabel: "Database",
                    })),
                  },
                ]
              : []),
          ],
        },
        surface: getServiceMenuSurface(service),
      };
    });
  const rootServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "root")
    .map((entry) => entry.item);
  const coreServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "core" && entry.item.title !== "Website")
    .map((entry) => entry.item);
  const workspaceServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "workspace")
    .map((entry) => entry.item);
  const settingsServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "settings")
    .map((entry) => entry.item);
  const contentItems: readonly DashboardNavItem[] = [
    {
      title: "All Content Types",
      url: "/content",
      icon: FileText,
      pageLabel: "Content",
      fixed: true,
      fixedOrder: 1,
    },
    {
      title: "Add Content Type",
      url: "/content/new",
      icon: Package,
      pageLabel: "Content",
      fixed: true,
      fixedOrder: 2,
    },
    ...((contentTypes ?? []).map((contentType) => ({
      title: contentType.label,
      icon: FileText,
      panelLabel: "Views",
      sectionLabel: "Collections",
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
      landingUrl: "/content",
      panelLabel: "Content Types",
      items: contentItems,
    },
    {
      title: "Media Gallery",
      url: "/media",
      icon: Files,
      pageLabel: "Media",
    },
    ...rootServiceNavItems,
    {
      title: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
    },
    {
      title: "Core",
      icon: Server,
      items: coreServiceNavItems,
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
        ...workspaceServiceNavItems,
        ...workspaceRegistryNavItems,
      ],
    },
    {
      title: "Settings",
      icon: Settings2,
      landingUrl: "/settings",
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
        ...settingsServiceNavItems,
      ],
    },
  ] as const;
}

export const platformNavItems = buildPlatformNavItems(
  defaultRuntimeServices,
  defaultRuntimeServiceRegistry,
);

export function buildMarketplacePackageItems(
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): readonly DashboardPackageItem[] {
  const registryEntries = buildDashboardServiceRegistryEntries(serviceRegistry);

  return [
    {
      name: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
      pageLabel: "Marketplace",
    },
    ...registryEntries.map((service) => ({
      name: service.name,
      url: service.status === "installed" ? service.menu.url : undefined,
      icon: service.menu.icon ?? Package,
      pageLabel: service.menu.pageLabel,
    })),
  ] as const;
}

export const marketplacePackageItems = buildMarketplacePackageItems(
  defaultRuntimeServiceRegistry,
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
  services?: readonly RuntimeService[],
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
) {
  return [
    ...flattenPlatformItems(buildPlatformNavItems(services, serviceRegistry)),
    ...buildMarketplacePackageItems(serviceRegistry)
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
  defaultRuntimeServices,
  defaultRuntimeServiceRegistry,
);

export function findServiceMenuPageByPath(
  pathname: string,
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): RuntimeServicePageDefinition | undefined {
  const search = (
    items: readonly DashboardServiceRegistryMenuItem[],
  ): RuntimeServicePageDefinition | undefined => {
    for (const item of items) {
      if (item.url === pathname && item.page) {
        return item.page;
      }

      const nested = search(item.items ?? []);
      if (nested) {
        return nested;
      }
    }

    return undefined;
  };

  return search(buildWorkspaceServiceNavItems(serviceRegistry));
}

export function getDashboardPageLabel(
  pathname: string,
  services?: readonly RuntimeService[],
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
) {
  if (pathname.startsWith("/database/")) {
    return "Database";
  }

  return (
    buildDashboardNavItems(services, serviceRegistry).find((item) => item.to === pathname)
      ?.label ?? "Not Found"
  );
}

export const serviceRows = [
  {
    name: "@zelavis/ui",
    path: "/zelavis",
    state: "ready",
    scope: "core",
  },
  {
    name: "@zelavis/auth",
    path: "/zelavis/api/v1/auth",
    state: "ready",
    scope: "core",
  },
  {
    name: "@zelavis/db",
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
    detail: "email and username services ready for registration",
  },
  {
    title: "Database",
    value: "document + sql",
    icon: Database,
    detail: "document operations with optional SQL capability",
  },
  {
    title: "Payments",
    value: "provider services",
    icon: CreditCard,
    detail: "Stripe and PayPal boundaries are package-level services",
  },
] as const;
