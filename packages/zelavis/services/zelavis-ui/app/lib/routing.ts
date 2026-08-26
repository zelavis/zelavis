export type DashboardSearch = Record<string, string | undefined>;

export function getProjectBasePath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function getProjectIdFromPathname(pathname: string) {
  return pathname.match(/(?:^|\/)projects\/([^/]+)/)?.[1];
}

export function isProjectRootPath(pathname: string) {
  return /^\/projects\/[^/]+\/?$/.test(pathname);
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

export function toProjectPath(path = "/", projectId?: string) {
  const resolvedId =
    projectId ??
    (typeof window === "undefined"
      ? undefined
      : getProjectIdFromPathname(window.location.pathname));

  if (!resolvedId) {
    throw new Error("A project ID is required to build a project route.");
  }

  const base = getProjectBasePath(resolvedId);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return normalizedPath === "/" ? base : `${base}${normalizedPath}`;
}

/**
 * Build a project-scoped path using the project ID extracted from a request
 * URL.  Use this in `clientAction` / `clientLoader` redirects where
 * `window.location` may not reflect the target project yet.
 */
export function toProjectPathFromUrl(path: string, requestUrl: string) {
  const projectId = getProjectIdFromPathname(new URL(requestUrl).pathname);

  if (!projectId) {
    throw new Error(`The request URL does not identify a project: ${requestUrl}`);
  }

  return toProjectPath(path, projectId);
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
