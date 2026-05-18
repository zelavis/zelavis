import type { UIMatch } from "react-router";

export type DashboardRouteHandle = {
  pageLabel?: string;
  sidebarTrail?: readonly string[];
};

export type DashboardRouteMatch = UIMatch<unknown, DashboardRouteHandle>;

export function getDashboardRouteHandle(
  matches: readonly UIMatch[],
): DashboardRouteHandle | undefined {
  return [...matches]
    .reverse()
    .map((match) => match.handle as DashboardRouteHandle | undefined)
    .find(
      (handle) =>
        typeof handle?.pageLabel === "string" ||
        Array.isArray(handle?.sidebarTrail),
    );
}

export function getDashboardPageLabelFromMatches(
  matches: readonly UIMatch[],
) {
  return getDashboardRouteHandle(matches)?.pageLabel;
}

export function getDashboardSidebarTrailFromMatches(
  matches: readonly UIMatch[],
) {
  return getDashboardRouteHandle(matches)?.sidebarTrail;
}
