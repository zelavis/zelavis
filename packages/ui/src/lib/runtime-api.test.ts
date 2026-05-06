import { expect, test } from "vitest";

import { getResolvedDashboardPreferences } from "./runtime-api";

test("getResolvedDashboardPreferences falls back to an empty object when preferences are missing", () => {
  expect(getResolvedDashboardPreferences({})).toEqual({});
});
