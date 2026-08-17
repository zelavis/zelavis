import {
  Activity,
  Bot,
  Boxes,
  CreditCard,
  Cpu,
  Database,
  Archive,
  Files,
  FileText,
  Fingerprint,
  Globe2,
  LayoutDashboard,
  MonitorCog,
  Package,
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
import type { DashboardSlotId } from "#/components/DashboardSlots";
import type {
  DatabaseCollection,
  RuntimeService,
  RuntimeServiceMenuDefinition,
  RuntimeServicePageDefinition,
  RuntimeServiceRegistryMenuDefinition,
  RuntimeServiceRegistryEntry,
} from "#/lib/runtime-api";
import type { ContentTypeRow } from "#/lib/content-studio";
import { isInternalDatabaseCollection } from "#/lib/database-collections";
import { toProjectPath } from "#/lib/routing";

export type DashboardRoutePath =
  | "/"
  | `/projects/${string}`
  | `/projects/${string}/${string}`
  | "/agents"
  | "/auth"
  | "/commerce"
  | "/commerce/customers"
  | "/commerce/coupons"
  | "/commerce/orders"
  | "/commerce/products"
  | "/content"
  | "/content/new"
  | `/content/${string}`
  | `/content/${string}/fields`
  | "/database"
  | "/database/new"
  | "/media"
  | "/marketplace"
  | "/projects"
  | "/resources"
  | "/security"
  | "/services"
  | "/settings"
  | "/settings/appearance"
  | "/storage"
  | "/users"
  | "/website"
  | `/${string}`;

export type DashboardNavSearch = {
  domainAction?: "add" | "buy" | "transfer";
  resourceView?: "processes" | "storage" | "limits";
  systemTable?:
    | "zv_collections"
    | "zv_events"
    | "zv_schemas"
    | "zv_time_series_checkpoints"
    | "zv_time_series_points";
  databaseTable?: string;
  new?: string;
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
  slot?: DashboardSlotId;
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

export type DashboardExtensionServiceItem = {
  id: string;
  name: string;
  menu: DashboardServiceRegistryMenuItem;
  status: "installed" | "available";
  source?: "official" | "community";
};

export type DashboardProjectItem = {
  id: string;
  name: string;
  logo: LucideIcon;
  domain: string;
  kind: "zelavis" | "wordpress" | "static" | "generic";
  status: "active" | "draft";
  updatedAt: string;
};

export const dashboardProjects: readonly DashboardProjectItem[] = [
  {
    id: "default",
    name: "Default project",
    logo: ZelavisMark,
    domain: "localhost",
    kind: "zelavis",
    status: "draft",
    updatedAt: "just now",
  },
] as const;

export const projectManagementNavItems: readonly DashboardNavItem[] = [
  {
    title: "Projects",
    url: "/projects",
    icon: LayoutDashboard,
    pageLabel: "Projects",
    sectionLabel: "Projects",
  },
  {
    title: "Marketplace",
    url: "/marketplace",
    icon: Boxes,
    pageLabel: "Marketplace",
    sectionLabel: "Explore",
  },
  {
    title: "Domains",
    landingUrl: "/server/domains",
    icon: Globe2,
    pageLabel: "Domains",
    sectionLabel: "Manage",
    items: [
      {
        title: "Overview",
        url: "/server/domains",
        icon: Globe2,
        pageLabel: "Domains",
        slot: "overview",
      },
      {
        title: "Add Domain",
        url: "/server/domains",
        search: { domainAction: "add" },
        icon: Plus,
        pageLabel: "Add Domain",
        slot: "create",
      },
      {
        title: "Buy",
        url: "/server/domains",
        search: { domainAction: "buy" },
        icon: CreditCard,
        pageLabel: "Buy Domain",
        slot: "create",
      },
      {
        title: "Transfer",
        url: "/server/domains",
        search: { domainAction: "transfer" },
        icon: Send,
        pageLabel: "Transfer Domain",
        slot: "create",
      },
    ],
  },
  {
    title: "Resources",
    icon: Activity,
    landingUrl: "/resources",
    pageLabel: "Resources",
    sectionLabel: "Manage",
    items: [
      {
        title: "Overview",
        url: "/resources",
        icon: Activity,
        pageLabel: "Resources",
      },
      {
        title: "Processes",
        url: "/resources",
        search: { resourceView: "processes" },
        icon: Cpu,
        pageLabel: "Processes",
      },
      {
        title: "Storage",
        url: "/resources",
        search: { resourceView: "storage" },
        icon: Database,
        pageLabel: "Storage",
      },
      {
        title: "Limits",
        url: "/resources",
        search: { resourceView: "limits" },
        icon: MonitorCog,
        pageLabel: "Limits",
      },
    ],
  },
  {
    title: "Server",
    icon: Server,
    landingUrl: "/server",
    pageLabel: "Server",
    sectionLabel: "Manage",
    items: [
      {
        title: "Overview",
        url: "/server",
        icon: Server,
        pageLabel: "Server",
      },
      {
        title: "Backups",
        url: "/server/backups",
        icon: Archive,
        pageLabel: "Backups",
      },
      {
        title: "Logs",
        url: "/server/logs",
        icon: ReceiptText,
        pageLabel: "Logs",
      },
    ],
  },
  {
    title: "Security",
    icon: ShieldCheck,
    landingUrl: "/security",
    pageLabel: "Security",
    sectionLabel: "Manage",
    items: [
      {
        title: "Checklist",
        url: "/security",
        icon: ShieldCheck,
        pageLabel: "Security",
        slot: "main",
      },
    ],
  },
] as const;

export function buildManagedProjectNavItems(
  projectId: string,
  kind: "wordpress" | "static" | "generic",
): readonly DashboardNavItem[] {
  const appAdminTitle = kind === "wordpress" ? "WordPress Admin" : "App Admin";

  return [
    {
      title: "Overview",
      url: toProjectPath("/", projectId) as DashboardRoutePath,
      icon: LayoutDashboard,
      pageLabel: "Overview",
      sectionLabel: "Overview",
    },
    {
      title: "Domains",
      url: toProjectPath("/domains", projectId) as DashboardRoutePath,
      icon: Globe2,
      pageLabel: "Domains",
      sectionLabel: "Hosting",
    },
    {
      title: "Files",
      url: toProjectPath("/files", projectId) as DashboardRoutePath,
      icon: Files,
      pageLabel: "Files",
      sectionLabel: "Hosting",
    },
    {
      title: "Database",
      url: toProjectPath("/database", projectId) as DashboardRoutePath,
      icon: Database,
      pageLabel: "Database",
      sectionLabel: "Hosting",
    },
    {
      title: "Backups",
      url: toProjectPath("/backups", projectId) as DashboardRoutePath,
      icon: Archive,
      pageLabel: "Backups",
      sectionLabel: "Operations",
    },
    {
      title: "Logs",
      url: toProjectPath("/logs", projectId) as DashboardRoutePath,
      icon: ReceiptText,
      pageLabel: "Logs",
      sectionLabel: "Operations",
    },
    {
      title: "Updates",
      url: toProjectPath("/updates", projectId) as DashboardRoutePath,
      icon: Package,
      pageLabel: "Updates",
      sectionLabel: "Operations",
    },
    {
      title: appAdminTitle,
      url: toProjectPath("/admin", projectId) as DashboardRoutePath,
      icon: MonitorCog,
      pageLabel: appAdminTitle,
      sectionLabel: "Settings",
    },
  ] as const;
}

function toDashboardRoutePath(path: string): DashboardRoutePath | undefined {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return undefined;
  }

  return path as DashboardRoutePath;
}

function toProjectRoutePath(path: string): DashboardRoutePath {
  return toProjectPath(path) as DashboardRoutePath;
}

function isBuiltInProjectPath(path: string) {
  if (path.startsWith("/content/")) {
    return true;
  }

  return [
    "/",
    "/agents",
    "/auth",
    "/commerce",
    "/commerce/customers",
    "/commerce/coupons",
    "/commerce/orders",
    "/commerce/products",
    "/content",
    "/content/new",
    "/database",
    "/database/new",
    "/media",
    "/marketplace",
    "/settings",
    "/storage",
    "/users",
    "/website",
  ].includes(path);
}

function toProjectMenuItem(item: DashboardNavItem): DashboardNavItem {
  return {
    ...item,
    url:
      item.url && isBuiltInProjectPath(item.url)
        ? toProjectRoutePath(item.url)
        : item.url,
    landingUrl:
      item.landingUrl && isBuiltInProjectPath(item.landingUrl)
        ? toProjectRoutePath(item.landingUrl)
        : item.landingUrl,
    items: item.items?.map(toProjectMenuItem),
  };
}

function createProjectAwareDashboardServiceMenuItem(
  menu: RuntimeServiceMenuDefinition,
  serviceName?: string,
): DashboardNavItem {
  return toProjectMenuItem(createDashboardServiceMenuItem(menu, serviceName));
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
      return Globe2;
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
): readonly DashboardExtensionServiceItem[] {
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

export function buildExtensionServiceNavItems(
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): readonly DashboardServiceRegistryMenuItem[] {
  // Installable services intentionally get exactly one root Extensions area.
  // Any nested navigation must live under that one root item so first-slide
  // ownership stays reserved for built-in product surfaces and core services.
  return buildDashboardServiceRegistryEntries(serviceRegistry)
    .filter((service) => service.status === "installed")
    .map((service) => service.menu);
}

export const extensionServiceNavItems =
  buildExtensionServiceNavItems(defaultRuntimeServiceRegistry);

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
            { title: "zv_collections", path: "/database" },
            { title: "zv_events", path: "/database" },
            { title: "zv_schemas", path: "/database" },
            { title: "zv_time_series_checkpoints", path: "/database" },
            { title: "zv_time_series_points", path: "/database" },
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
      path: "/website",
      pageLabel: "Website",
    },
  },
] as const;

export function buildPlatformNavItems(
  services?: readonly RuntimeService[],
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
  contentTypes?: readonly ContentTypeRow[],
  databaseCollections?: readonly DatabaseCollection[],
): readonly DashboardNavItem[] {
  const extensionRegistryNavItems = buildExtensionServiceNavItems(serviceRegistry);
  const contentTypesByName = new Map(
    (contentTypes ?? []).map((contentType) => [contentType.name, contentType]),
  );
  const databaseTableItems = [...(databaseCollections ?? [])]
    .filter((collection) => !isInternalDatabaseCollection(collection.name))
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
        ? createProjectAwareDashboardServiceMenuItem(service.menu, service.name)
        : {
            title: service.name,
            icon: getServiceMenuIcon(service.name, service.name),
          };

      if (service.name !== "@zelavis/db") {
        return {
          item: baseMenu,
          surface: getServiceMenuSurface(service),
          serviceName: service.name,
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
        serviceName: service.name,
      };
    });
  const rootServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "root")
    .map((entry) => entry.item);
  const coreServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "core" && entry.serviceName !== "@zelavis/website")
    .map((entry) => entry.item);
  const extensionSurfaceServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "extensions")
    .map((entry) => entry.item);
  const settingsServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "settings")
    .map((entry) => entry.item);
  const hasWebsiteService = (services ?? defaultRuntimeServices).some(
    (service) => service.name === "@zelavis/website",
  );
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
      panelLabel: contentType.label,
      landingUrl: `/content/${contentType.name}` as DashboardRoutePath,
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
      ],
    })) as readonly DashboardNavItem[]),
  ];

  const rawItems: readonly DashboardNavItem[] = [
    {
      title: "Overview",
      url: "/",
      icon: LayoutDashboard,
      sectionLabel: "Overview",
    },
    {
      title: "Users",
      url: "/users",
      icon: Users,
      sectionLabel: "Build",
    },
    {
      title: "Content",
      icon: FileText,
      landingUrl: "/content",
      panelLabel: "Content Types",
      sectionLabel: "Build",
      items: contentItems,
    },
    {
      title: "Media",
      url: "/media",
      icon: Files,
      pageLabel: "Media",
      sectionLabel: "Build",
    },
    ...(hasWebsiteService
      ? [
          {
            title: "Website",
            url: "/website" as const,
            icon: Globe2,
            pageLabel: "Website",
            sectionLabel: "Build",
          },
        ]
      : []),
    ...rootServiceNavItems,
    {
      title: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
      pageLabel: "Marketplace",
      sectionLabel: "Extend",
    },
    {
      title: "Extensions",
      icon: Bot,
      sectionLabel: "Extend",
      items: [
        {
          title: "Agents",
          url: "/agents",
          icon: Bot,
        },
        ...extensionSurfaceServiceNavItems,
        ...extensionRegistryNavItems,
      ],
    },
    {
      title: "Backend",
      icon: Server,
      sectionLabel: "Backend",
      items: coreServiceNavItems,
    },
    {
      title: "Settings",
      icon: Settings2,
      landingUrl: "/settings",
      sectionLabel: "Settings",
      items: [
        {
          title: "Project Settings",
          url: "/settings",
          icon: Settings2,
          pageLabel: "Settings",
        },
        ...settingsServiceNavItems,
      ],
    },
  ] as const;

  return rawItems.map(toProjectMenuItem);
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

  return search(buildExtensionServiceNavItems(serviceRegistry));
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
