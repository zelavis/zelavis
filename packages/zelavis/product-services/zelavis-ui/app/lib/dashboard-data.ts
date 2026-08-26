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
  ReceiptText,
  Server,
  Settings2,
  ShieldCheck,
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
  RuntimeAccessRequirement,
  RuntimeDashboardAccess,
  RuntimePrincipal,
  RuntimeProject,
} from "#/lib/runtime-api";
import type { ContentTypeRow } from "#/lib/content-studio";
import { getProjectIdFromPathname, toProjectPath } from "#/lib/routing";

export type DashboardRoutePath =
  | "/"
  | `/projects/${string}`
  | `/projects/${string}/${string}`
  | "/agents"
  | "/auth"
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
  [key: string]: string | undefined;
  domainAction?: "add" | "buy" | "transfer";
  resourceView?: "processes" | "storage" | "limits";
  workloadView?: "functions" | "jobs" | "schedules" | "webhooks";
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
  order?: number;
  fixed?: boolean;
  fixedOrder?: number;
  fixedActionScope?: "local" | "inherit" | "replace" | "clear";
  sectionLabel?: string;
  disabled?: boolean;
  access?: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[];
  page?: RuntimeServicePageDefinition;
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
  landingUrl?: DashboardRoutePath;
  search?: DashboardNavSearch;
  icon: LucideIcon;
  panelLabel?: string;
  pageLabel?: string;
  order?: number;
  fixed?: boolean;
  fixedOrder?: number;
  fixedActionScope?: "local" | "inherit" | "replace" | "clear";
  sectionLabel?: string;
  disabled?: boolean;
  page?: RuntimeServicePageDefinition;
  serviceOwned?: boolean;
  items?: readonly DashboardServiceRegistryMenuItem[];
};

export type DashboardExtensionServiceItem = {
  id: string;
  name: string;
  menu: DashboardServiceRegistryMenuItem;
  surface: "platform" | "root" | "core" | "extensions" | "settings";
  status: "installed" | "available";
  source?: "official" | "community";
};

function menuHasSlideContent(menu: {
  items?: readonly unknown[];
  dynamicItems?: unknown;
}) {
  return Boolean(menu.items?.length || menu.dynamicItems);
}

export type DashboardProjectItem = {
  id: string;
  name: string;
  logo: LucideIcon;
  domain: string;
  kind: string;
  status: "active" | "draft";
  updatedAt: string;
};

export function toDashboardProjectItem(project: RuntimeProject): DashboardProjectItem {
  let domain = "Local runtime";
  if (project.runtime.url) {
    try {
      domain = new URL(project.runtime.url).host;
    } catch {
      domain = project.runtime.url;
    }
  }

  return {
    id: project.id,
    name: project.name,
    logo: ZelavisMark,
    domain,
    kind: project.kind,
    status: project.runtime.status === "running" ? "active" : "draft",
    updatedAt: project.updatedAt,
  };
}

function matchScopeValue(
  required: string | undefined,
  granted: string | undefined,
) {
  return required === undefined || granted === undefined || required === granted;
}

function scopesMatch(
  requirement: RuntimeAccessRequirement,
  grant: NonNullable<RuntimePrincipal["grants"]>[number],
) {
  const requiredScope = requirement.scope;
  const grantScope = grant.scope;

  if (!requiredScope) {
    return true;
  }

  if (!grantScope) {
    return requiredScope.type === "system";
  }

  if (requiredScope.type !== grantScope.type) {
    return false;
  }

  if (requiredScope.type === "project" && grantScope.type === "project") {
    return matchScopeValue(requiredScope.projectId, grantScope.projectId);
  }

  if (requiredScope.type === "service" && grantScope.type === "service") {
    return matchScopeValue(requiredScope.serviceName, grantScope.serviceName);
  }

  return true;
}

function principalHasPermission(
  principal: RuntimePrincipal,
  permission: string,
  requirement: RuntimeAccessRequirement,
) {
  if (
    principal.permissions?.includes("*") ||
    principal.permissions?.includes(permission)
  ) {
    return true;
  }

  return (
    principal.grants?.some(
      (grant) =>
        (grant.permission === "*" || grant.permission === permission) &&
        scopesMatch(requirement, grant),
    ) ?? false
  );
}

function canAccessRequirement(
  access: RuntimeDashboardAccess | undefined,
  requirement: RuntimeAccessRequirement,
) {
  if (!access) {
    return true;
  }

  const principal = access.principal;
  const requiresAuthentication =
    requirement.authenticated === true ||
    Boolean(requirement.roles?.length) ||
    Boolean(requirement.permissions?.length);

  if (requiresAuthentication && principal.type === "anonymous") {
    return false;
  }

  if (
    requirement.roles?.length &&
    !requirement.roles.some((role) => principal.roles?.includes(role))
  ) {
    return false;
  }

  return (
    requirement.permissions?.every((permission) =>
      principalHasPermission(principal, permission, requirement),
    ) ?? true
  );
}

export function canAccessDashboardItem(
  access: RuntimeDashboardAccess | undefined,
  item: Pick<DashboardNavItem, "access">,
) {
  if (!item.access) {
    return true;
  }

  const requirements = Array.isArray(item.access) ? item.access : [item.access];
  return requirements.some((requirement) =>
    canAccessRequirement(access, requirement),
  );
}

export function filterDashboardNavItemsForAccess(
  items: readonly DashboardNavItem[],
  access?: RuntimeDashboardAccess,
): readonly DashboardNavItem[] {
  return items
    .filter((item) => canAccessDashboardItem(access, item))
    .map((item) => ({
      ...item,
      items: item.items
        ? filterDashboardNavItemsForAccess(item.items, access)
        : undefined,
    }));
}

export function getDashboardProjectsForAccess(
  projects: readonly DashboardProjectItem[],
  access?: RuntimeDashboardAccess,
): readonly DashboardProjectItem[] {
  if (!access?.projects?.length || access.principal.permissions?.includes("*")) {
    return projects;
  }

  const allowedProjectIds = new Set(access.projects.map((project) => project.id));
  return projects.filter((project) => allowedProjectIds.has(project.id));
}

function projectAccess(
  permission: string,
  projectId: string,
): RuntimeAccessRequirement {
  return {
    permissions: [permission],
    scope: { type: "project", projectId },
  };
}

function sortRootNavItems(items: readonly DashboardNavItem[]): readonly DashboardNavItem[] {
  return [...items].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) -
        (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.title.localeCompare(right.title),
  );
}

export function buildProjectManagementNavItems(
  services?: readonly RuntimeService[],
): readonly DashboardNavItem[] {
  const platformServiceNavItems = (services ?? [])
    .filter((service) => service.core)
    .flatMap((service) =>
      [service.menu, ...(service.menus ?? [])]
        .filter(
          (menu): menu is RuntimeServiceMenuDefinition => {
            if (!menu) {
              return false;
            }

            return (
              (menu.surface ?? getServiceMenuSurface(service)) === "platform"
            );
          },
        )
        .map((menu) => createDashboardServiceMenuItem(menu, service.name)),
    );

  return sortRootNavItems([
    {
      title: "Projects",
      url: "/projects",
      icon: LayoutDashboard,
      pageLabel: "Projects",
      sectionLabel: "Projects",
      order: 10,
      access: {
        permissions: ["projects.list"],
        scope: { type: "system" },
      },
    },
    ...platformServiceNavItems,
    {
      title: "Resources",
      icon: Activity,
      landingUrl: "/resources",
      pageLabel: "Resources",
      sectionLabel: "Manage",
      order: 50,
      access: {
        permissions: ["server.resources.view"],
        scope: { type: "system" },
      },
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
      title: "Security",
      icon: ShieldCheck,
      landingUrl: "/security",
      order: 70,
      access: {
        permissions: ["server.security.view"],
        scope: { type: "system" },
      },
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
  ] as const);
}

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

function toProjectRoutePath(path: string, projectId: string): DashboardRoutePath {
  return toProjectPath(path, projectId) as DashboardRoutePath;
}

function isBuiltInProjectPath(path: string) {
  if (path.startsWith("/content/")) {
    return true;
  }

  if (path.startsWith("/workloads/")) {
    return true;
  }

  return [
    "/",
    "/agents",
    "/auth",
    "/backend",
    "/content",
    "/content/new",
    "/database",
    "/database/new",
    "/extensions",
    "/media",
    "/marketplace",
    "/settings",
    "/storage",
    "/users",
    "/website",
    "/workloads",
  ].includes(path);
}

function toProjectMenuItem(
  item: DashboardNavItem,
  projectId: string,
): DashboardNavItem {
  return {
    ...item,
    url:
      item.url && isBuiltInProjectPath(item.url)
        ? toProjectRoutePath(item.url, projectId)
        : item.url,
    landingUrl:
      item.landingUrl && isBuiltInProjectPath(item.landingUrl)
        ? toProjectRoutePath(item.landingUrl, projectId)
        : item.landingUrl,
    items: item.items?.map((child) => toProjectMenuItem(child, projectId)),
  };
}

function materializeProjectAccessRequirement(
  requirement: RuntimeAccessRequirement,
  projectId: string,
): RuntimeAccessRequirement {
  if (
    requirement.scope?.type === "project" &&
    "projectIdParam" in requirement.scope
  ) {
    return {
      ...requirement,
      scope: {
        type: "project",
        projectId,
      },
    };
  }

  return requirement;
}

function isAccessRequirementArray(
  access: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[],
): access is readonly RuntimeAccessRequirement[] {
  return Array.isArray(access);
}

function materializeProjectAccess(
  access: RuntimeAccessRequirement | readonly RuntimeAccessRequirement[] | undefined,
  projectId: string,
) {
  if (!access) {
    return undefined;
  }

  return isAccessRequirementArray(access)
    ? access.map((requirement) =>
        materializeProjectAccessRequirement(requirement, projectId),
      )
    : materializeProjectAccessRequirement(access, projectId);
}

function materializeProjectMenuItemAccess(
  item: DashboardNavItem,
  menu: RuntimeServiceMenuDefinition,
  projectId: string,
): DashboardNavItem {
  return {
    ...item,
    access: materializeProjectAccess(menu.access, projectId),
    items: item.items?.map((child, index) => {
      const childMenu = menu.items?.[index];
      return childMenu
        ? materializeProjectMenuItemAccess(child, childMenu, projectId)
        : child;
    }),
  };
}

function createProjectAwareDashboardServiceMenuItem(
  menu: RuntimeServiceMenuDefinition,
  serviceName: string | undefined,
  projectId: string,
): DashboardNavItem {
  return toProjectMenuItem(
    materializeProjectMenuItemAccess(
      createDashboardServiceMenuItem(menu, serviceName),
      menu,
      projectId,
    ),
    projectId,
  );
}

function slugifyServiceName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getServiceRegistryMenuIcon(title: string): LucideIcon {
  switch (title.toLowerCase()) {
    case "more":
      return Package;
    default:
      return Package;
  }
}

function createDashboardServiceRegistryMenuItem(
  menu: RuntimeServiceRegistryMenuDefinition,
  serviceName?: string,
  parentSegments: readonly string[] = [],
): DashboardServiceRegistryMenuItem {
  const path = menu.path ?? deriveServiceMenuPath(menu.title, serviceName, parentSegments);
  const nextSegments = [...parentSegments, slugifyMenuSegment(menu.title)];

  return {
    title: menu.title,
    url: toDashboardRoutePath(path),
    search: menu.search,
    landingUrl:
      menuHasSlideContent(menu)
        ? toDashboardRoutePath(path)
        : undefined,
    icon: getServiceRegistryMenuIcon(menu.title),
    pageLabel: menu.pageLabel,
    panelLabel: menu.panelLabel,
    order: menu.order,
    fixed: menu.fixed,
    fixedOrder: menu.fixedOrder,
    fixedActionScope: menu.fixedActionScope,
    sectionLabel: menu.sectionLabel,
    disabled: menu.disabled,
    page: menu.page,
    serviceOwned: true,
    items: menu.items?.map((item) =>
      createDashboardServiceRegistryMenuItem(item, serviceName, nextSegments),
    ),
  };
}

function getServiceMenuIcon(title: string, serviceName?: string): LucideIcon {
  switch (title.toLowerCase()) {
    case "server":
      return Server;
    case "domains":
      return Globe2;
    case "access":
      return Fingerprint;
    case "backups":
      return Archive;
    case "logs":
      return ReceiptText;
  }

  switch (serviceName ?? title.toLowerCase()) {
    case "@zelavis/core":
      return Fingerprint;
    case "@zelavis/marketplace":
      return Boxes;
    case "@zelavis/auth":
      return Fingerprint;
    case "@zelavis/db":
      return Database;
    case "@zelavis/storage":
      return Files;
    case "@zelavis/website":
      return Globe2;
    case "@zelavis/workloads":
      return Cpu;
    default:
      return Server;
  }
}

function createDashboardServiceMenuItem(
  menu: RuntimeServiceMenuDefinition,
  serviceName?: string,
  parentSegments: readonly string[] = [],
): DashboardNavItem {
  const path = menu.path ?? deriveServiceMenuPath(menu.title, serviceName, parentSegments);
  const nextSegments = [...parentSegments, slugifyMenuSegment(menu.title)];

  return {
    title: menu.title,
    url: toDashboardRoutePath(path),
    search: menu.search,
    landingUrl:
      menuHasSlideContent(menu)
        ? toDashboardRoutePath(path)
        : undefined,
    icon: getServiceMenuIcon(menu.title, serviceName),
    pageLabel: menu.pageLabel,
    panelLabel: menu.panelLabel,
    order: menu.order,
    fixed: menu.fixed,
    fixedOrder: menu.fixedOrder,
    fixedActionScope: menu.fixedActionScope,
    sectionLabel: menu.sectionLabel,
    disabled: menu.disabled,
    access: menu.access,
    page: menu.page,
    items: menu.items?.map((item) =>
      createDashboardServiceMenuItem(item, serviceName, nextSegments),
    ),
  };
}

function deriveServiceMenuPath(
  title: string,
  serviceName: string | undefined,
  parentSegments: readonly string[],
) {
  const serviceSegment = serviceName
    ? slugifyServiceSegment(serviceName)
    : undefined;
  const titleSegment = slugifyMenuSegment(title);
  const segments = [
    serviceSegment &&
    ((parentSegments.length === 0 && serviceSegment === titleSegment) ||
      parentSegments[0] === serviceSegment)
      ? undefined
      : serviceSegment,
    ...parentSegments,
    parentSegments.at(-1) === titleSegment ? undefined : titleSegment,
  ].filter(Boolean);

  return `/${segments.join("/")}`;
}

function slugifyServiceSegment(value: string) {
  return value
    .replace(/^@/, "")
    .replace(/^zelavis\//, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugifyMenuSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type DashboardServiceSurface = NonNullable<RuntimeServiceMenuDefinition["surface"]>;

function getServiceMenuSurface(service: RuntimeService): DashboardServiceSurface {
  return service.menu?.surface ?? "core";
}

function getRuntimeServiceMenus(
  service: RuntimeService,
): readonly RuntimeServiceMenuDefinition[] {
  return [service.menu, ...(service.menus ?? [])].filter(
    (menu): menu is RuntimeServiceMenuDefinition => Boolean(menu),
  );
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
            surface: service.menu.surface ?? "extensions",
            menu: createDashboardServiceRegistryMenuItem(
              service.menu,
              service.name,
            ),
          },
        ]
      : [],
  )
}

const defaultRuntimeServiceRegistry = [] as const satisfies readonly RuntimeServiceRegistryEntry[];

export const dashboardServiceRegistryEntries =
  buildDashboardServiceRegistryEntries(defaultRuntimeServiceRegistry);

export function buildExtensionServiceNavItems(
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): readonly DashboardServiceRegistryMenuItem[] {
  // Installable services intentionally get exactly one root Extensions area.
  // Any nested navigation must live under that one root item so first-slide
  // ownership stays reserved for built-in product surfaces and core services.
  return buildDashboardServiceRegistryEntries(serviceRegistry)
    .filter(
      (service) =>
        service.status === "installed" && service.surface === "extensions",
    )
    .map((service) => service.menu);
}

export const extensionServiceNavItems =
  buildExtensionServiceNavItems(defaultRuntimeServiceRegistry);

const defaultRuntimeServices: readonly RuntimeService[] = [
  {
    name: "@zelavis/core",
    core: true,
    apiPath: "/api/v1/runtime",
    menu: {
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
    },
  },
  {
    name: "@zelavis/marketplace",
    core: true,
    apiPath: "/api/v1/marketplace",
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
  },
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
      path: "/database",
      surface: "core",
      panelLabel: "Database",
      dynamicItems: {
        path: "/database/menu/tables",
        emptyTitle: "No tables yet",
      },
      items: [
        {
          title: "Create Table",
          path: "/database/new",
          pageLabel: "Database",
          fixed: true,
          fixedOrder: 1,
        },
        {
          title: "System Tables",
          path: "/database",
          search: { systemTable: "zv_collections" },
          panelLabel: "System Tables",
          items: [
            {
              title: "zv_collections",
              path: "/database",
              pageLabel: "Database",
              search: { systemTable: "zv_collections" },
            },
            {
              title: "zv_events",
              path: "/database",
              pageLabel: "Database",
              search: { systemTable: "zv_events" },
            },
            {
              title: "zv_schemas",
              path: "/database",
              pageLabel: "Database",
              search: { systemTable: "zv_schemas" },
            },
            {
              title: "zv_time_series_checkpoints",
              path: "/database",
              pageLabel: "Database",
              search: { systemTable: "zv_time_series_checkpoints" },
            },
            {
              title: "zv_time_series_points",
              path: "/database",
              pageLabel: "Database",
              search: { systemTable: "zv_time_series_points" },
            },
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
      sectionLabel: "Build",
      surface: "root",
      access: {
        permissions: ["project.website.manage"],
        scope: { type: "project", projectIdParam: "projectId" },
      },
    },
  },
] as const;

export const projectManagementNavItems: readonly DashboardNavItem[] =
  buildProjectManagementNavItems(defaultRuntimeServices);

export function buildPlatformNavItems(
  services: readonly RuntimeService[] | undefined,
  serviceRegistry: readonly RuntimeServiceRegistryEntry[] | undefined,
  contentTypes: readonly ContentTypeRow[] | undefined,
  databaseCollections: readonly DatabaseCollection[] | undefined,
  projectId: string,
): readonly DashboardNavItem[] {
  const extensionRegistryNavItems = buildExtensionServiceNavItems(serviceRegistry);
  void databaseCollections;
  const serviceNavItems = (services ?? [])
    .filter((service) => service.core && service.name !== "@zelavis/ui")
    .flatMap((service) => {
      const menus = getRuntimeServiceMenus(service);
      if (menus.length === 0) {
        return [
          {
            item: {
              title: service.name,
              icon: getServiceMenuIcon(service.name, service.name),
            },
            surface: getServiceMenuSurface(service),
            serviceName: service.name,
          },
        ];
      }

      return menus.map((menu) => ({
        item: createProjectAwareDashboardServiceMenuItem(
          menu,
          service.name,
          projectId,
        ),
        surface: menu.surface ?? getServiceMenuSurface(service),
        serviceName: service.name,
      }));
    });
  const rootServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "root")
    .map((entry) => entry.item);
  const coreServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "core")
    .map((entry) => entry.item);
  const extensionSurfaceServiceNavItems = serviceNavItems
    .filter((entry) => entry.surface === "extensions")
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
      access: projectAccess("project.view", projectId),
    },
    {
      title: "Users",
      url: "/users",
      icon: Users,
      sectionLabel: "Build",
      access: projectAccess("project.users.manage", projectId),
    },
    {
      title: "Content",
      icon: FileText,
      landingUrl: "/content",
      panelLabel: "Content Types",
      sectionLabel: "Build",
      access: projectAccess("project.content.read", projectId),
      items: contentItems,
    },
    {
      title: "Media",
      url: "/media",
      icon: Files,
      pageLabel: "Media",
      sectionLabel: "Build",
      access: projectAccess("project.media.manage", projectId),
    },
    ...rootServiceNavItems,
    {
      title: "Marketplace",
      url: "/marketplace",
      icon: Boxes,
      pageLabel: "Marketplace",
      sectionLabel: "Extend",
      access: projectAccess("project.marketplace.manage", projectId),
    },
    {
      title: "Extensions",
      icon: Bot,
      landingUrl: "/extensions",
      panelLabel: "Extensions",
      sectionLabel: "Extend",
      access: projectAccess("project.extensions.manage", projectId),
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
      landingUrl: "/backend",
      panelLabel: "Backend",
      sectionLabel: "Backend",
      access: projectAccess("project.backend.manage", projectId),
      items: coreServiceNavItems,
    },
    {
      title: "Settings",
      icon: Settings2,
      landingUrl: "/settings",
      sectionLabel: "Settings",
      access: projectAccess("project.settings.manage", projectId),
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

  return rawItems.map((item) => {
    if (item.title === "Backend") {
      return {
        ...item,
        url: item.url ? toProjectRoutePath(item.url, projectId) : undefined,
        landingUrl: item.landingUrl
          ? toProjectRoutePath(item.landingUrl, projectId)
          : undefined,
      };
    }
    return toProjectMenuItem(item, projectId);
  });
}

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
  projectId?: string,
) {
  return [
    ...(projectId
      ? flattenPlatformItems(
          buildPlatformNavItems(
            services,
            serviceRegistry,
            undefined,
            undefined,
            projectId,
          ),
        )
      : []),
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

export type DashboardMenuContent =
  | {
      kind: "frame";
      title: string;
      page: RuntimeServicePageDefinition;
    }
  | {
      kind: "placeholder";
      title: string;
      description: string;
    };

export function findServiceMenuContentByPath(
  pathname: string,
  services?: readonly RuntimeService[],
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): DashboardMenuContent | undefined {
  const projectId = getProjectIdFromPathname(pathname);
  const items = projectId
    ? buildPlatformNavItems(
        services,
        serviceRegistry,
        undefined,
        undefined,
        projectId,
      )
    : [
        ...buildProjectManagementNavItems(services),
        ...buildExtensionServiceNavItems(serviceRegistry),
      ];

  const search = (items: readonly DashboardNavItem[]): DashboardMenuContent | undefined => {
    for (const item of items) {
      if (item.url === pathname && item.page) {
        return {
          kind: "frame",
          title: item.page.title ?? item.pageLabel ?? item.title,
          page: item.page,
        };
      }

      if (item.url === pathname || item.landingUrl === pathname) {
        return {
          kind: "placeholder",
          title: item.pageLabel ?? item.panelLabel ?? item.title,
          description: `${item.title} is ready for a service-provided page or a dashboard route.`,
        };
      }

      const nested = search(item.items ?? []);
      if (nested) {
        return nested;
      }
    }

    return undefined;
  };

  return search(items);
}

export function findServiceMenuPageByPath(
  pathname: string,
  serviceRegistry?: readonly RuntimeServiceRegistryEntry[],
): RuntimeServicePageDefinition | undefined {
  const content = findServiceMenuContentByPath(pathname, undefined, serviceRegistry);

  return content?.kind === "frame" ? content.page : undefined;
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
    buildDashboardNavItems(
      services,
      serviceRegistry,
      getProjectIdFromPathname(pathname),
    ).find((item) => item.to === pathname)
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
