import type { UIMatch } from "react-router";

import type { DashboardSlotDefinition } from "#/components/DashboardSlots";

export type DashboardRouteHandle = {
  pageLabel?: string;
  sidebarTrail?: readonly string[];
  slots?: readonly DashboardSlotDefinition[];
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
        Array.isArray(handle?.sidebarTrail) ||
        Array.isArray(handle?.slots),
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

export function getDashboardSlotsFromMatches(matches: readonly UIMatch[]) {
  return getDashboardRouteHandle(matches)?.slots ?? [];
}
