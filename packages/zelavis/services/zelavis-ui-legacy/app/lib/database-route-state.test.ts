import { expect, test } from "vitest";

import { getDatabaseSidebarTrail } from "./database-route-state";

test("database overview stays on the database sidebar panel", () => {
  expect(getDatabaseSidebarTrail({})).toBe("Backend/Database");
});

test("collection tables stay on the database sidebar panel", () => {
  expect(getDatabaseSidebarTrail({ databaseTable: "pokemon" })).toBe(
    "Backend/Database",
  );
});
