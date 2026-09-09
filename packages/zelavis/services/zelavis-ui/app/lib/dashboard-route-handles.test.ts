import { describe, expect, it } from "vitest";
import type { UIMatch } from "react-router";

import {
  getDashboardPageLabelFromMatches,
  getDashboardSidebarTrailFromMatches,
  getDashboardSlotsFromMatches,
  type DashboardRouteHandle,
} from "#/lib/dashboard-route-handles";

function createMatch(id: string, handle?: DashboardRouteHandle): UIMatch {
  return {
    id,
    pathname: "/zelavis",
    params: {},
    loaderData: undefined,
    handle,
  };
}

describe("dashboard route handles", () => {
  it("reads the nearest dashboard handle from the deepest route", () => {
    const matches = [
      createMatch("root", { pageLabel: "Root" }),
      createMatch(
        "routes/security",
        {
          pageLabel: "Security",
          sidebarTrail: ["Security"],
          slots: [{ id: "main", label: "Linux security checklist" }],
        },
      ),
    ];

    expect(getDashboardPageLabelFromMatches(matches)).toBe("Security");
    expect(getDashboardSidebarTrailFromMatches(matches)).toEqual(["Security"]);
    expect(getDashboardSlotsFromMatches(matches)).toEqual([
      { id: "main", label: "Linux security checklist" },
    ]);
  });

  it("returns an empty slot list when a route has no slot metadata", () => {
    expect(
      getDashboardSlotsFromMatches([createMatch("root", { pageLabel: "Root" })]),
    ).toEqual([]);
  });
});
