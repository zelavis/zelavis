export type DashboardSearch = Record<string, string | undefined>;

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
