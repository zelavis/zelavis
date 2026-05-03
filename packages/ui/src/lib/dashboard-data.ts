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

export const packageNavItems: readonly DashboardPackageItem[] = [
  {
    name: "Marketplace",
    url: "/marketplace",
    icon: Boxes,
  },
  {
    name: "Zelavis Ecommerce",
    url: "/commerce",
    icon: Store,
    pageLabel: "Commerce",
  },
  {
    name: "Placeholder 01",
    icon: Package,
  },
  {
    name: "Placeholder 02",
    icon: Package,
  },
  {
    name: "Placeholder 03",
    icon: Package,
  },
  {
    name: "Placeholder 04",
    icon: Package,
  },
  {
    name: "Placeholder 05",
    icon: Package,
  },
  {
    name: "Placeholder 06",
    icon: Package,
  },
  {
    name: "Placeholder 07",
    icon: Package,
  },
  {
    name: "Placeholder 08",
    icon: Package,
  },
  {
    name: "Placeholder 09",
    icon: Package,
  },
  {
    name: "Placeholder 10",
    icon: Package,
  },
  {
    name: "Placeholder 11",
    icon: Package,
  },
  {
    name: "Placeholder 12",
    icon: Package,
  },
  {
    name: "Placeholder 13",
    icon: Package,
  },
  {
    name: "Placeholder 14",
    icon: Package,
  },
  {
    name: "Placeholder 15",
    icon: Package,
  },
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
  ...packageNavItems
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
