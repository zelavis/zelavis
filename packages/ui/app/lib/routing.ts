export type DashboardSearch = Record<string, string | undefined>;

export const DEFAULT_PROJECT_ID = "default";

export function getProjectBasePath(projectId = DEFAULT_PROJECT_ID) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function getProjectIdFromPathname(pathname: string) {
  return pathname.match(/^\/projects\/([^/]+)/)?.[1];
}

export function getManagedProjectKindFromId(projectId: string | undefined) {
  if (projectId?.startsWith("wordpress-")) {
    return "wordpress";
  }

  if (projectId?.startsWith("static-")) {
    return "static";
  }

  if (projectId?.startsWith("generic-")) {
    return "generic";
  }

  return undefined;
}

export function toProjectPath(path = "/", projectId = DEFAULT_PROJECT_ID) {
  const base = getProjectBasePath(projectId);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return normalizedPath === "/" ? base : `${base}${normalizedPath}`;
}

export function isProjectManagementPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/projects" ||
    pathname === "/marketplace" ||
    pathname === "/resources" ||
    pathname === "/security" ||
    pathname === "/services" ||
    pathname === "/server" ||
    pathname === "/settings" ||
    pathname === "/settings/appearance" ||
    pathname.startsWith("/server/")
  );
}

export function matchesProjectPath(pathname: string, projectPath: string) {
  const normalizedProjectPath = projectPath.startsWith("/")
    ? projectPath
    : `/${projectPath}`;
  const projectMatch = pathname.match(/^\/projects\/[^/]+(?<rest>\/.*)?$/);

  if (!projectMatch) {
    return false;
  }

  const rest = projectMatch.groups?.rest ?? "/";
  return rest === normalizedProjectPath;
}

export function readSearchParams(search: string): DashboardSearch {
  return Object.fromEntries(new URLSearchParams(search).entries());
}

export function mergeSearchParams(
  currentSearch: string,
  nextSearch: DashboardSearch,
) {
  const params = new URLSearchParams(currentSearch);

  for (const [key, value] of Object.entries(nextSearch)) {
    if (value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }

  const next = params.toString();
  return next ? `?${next}` : "";
}

export function toDashboardPath(path: string, search?: DashboardSearch) {
  const normalizedPath = path || "/";
  const query = search ? mergeSearchParams("", search) : "";
  return `${normalizedPath}${query}`;
}
