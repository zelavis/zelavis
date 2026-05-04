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
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react";

export type DashboardRoutePath =
  | "/"
  | "/agents"
  | "/auth"
  | "/builder"
  | "/builder/pages"
  | "/commerce"
  | "/content"
  | "/database"
  | "/marketplace"
  | "/services"
  | "/settings"
  | "/settings/appearance"
  | "/storage"
  | "/users";

export type DashboardNavItem = {
  title: string;
  url?: DashboardRoutePath;
  icon: LucideIcon;
  pageLabel?: string;
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
  url: DashboardRoutePath;
  icon: LucideIcon;
  pageLabel?: string;
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

export const dashboardPluginRegistryEntries: readonly DashboardWorkspacePluginItem[] = [
  {
    id: "ecommerce",
    name: "Zelavis Ecommerce",
    status: "installed",
    source: "official",
    menu: {
      title: "Ecommerce",
      url: "/commerce",
      icon: Store,
      pageLabel: "Commerce",
    },
  },
] as const;

export const workspacePluginNavItems = dashboardPluginRegistryEntries
  .filter((plugin) => plugin.status === "installed")
  .map((plugin) => plugin.menu);

export const platformNavItems: readonly DashboardNavItem[] = [
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
    url: "/content",
    icon: FileText,
  },
  {
    title: "Storage",
    url: "/storage",
    icon: Files,
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
        url: "/database",
        icon: Database,
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
      ...workspacePluginNavItems,
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

export const marketplacePackageItems: readonly DashboardPackageItem[] = [
  {
    name: "Marketplace",
    url: "/marketplace",
    icon: Boxes,
    pageLabel: "Marketplace",
  },
  ...dashboardPluginRegistryEntries.map((plugin) => ({
    name: plugin.name,
    url: plugin.status === "installed" ? plugin.menu.url : undefined,
    icon: plugin.menu.icon ?? Package,
    pageLabel: plugin.menu.pageLabel,
  })),
] as const;

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

export const dashboardNavItems = [
  ...flattenPlatformItems(platformNavItems),
  ...marketplacePackageItems
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

export function getDashboardPageLabel(pathname: string) {
  return (
    dashboardNavItems.find((item) => item.to === pathname)?.label ?? "Not Found"
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
