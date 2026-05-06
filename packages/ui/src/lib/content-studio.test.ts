import { expect, test } from "vitest";

import { buildContentTypeRows } from "./content-studio";

test("buildContentTypeRows respects pinned type order from preferences", () => {
  const rows = buildContentTypeRows(
    [
      {
        name: "posts",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 4,
      },
      {
        name: "pages",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 2,
      },
      {
        name: "authors",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 1,
      },
    ],
    [
      {
        collection: "posts",
        activeVersion: 1,
        versions: [1],
      },
      {
        collection: "pages",
        activeVersion: 2,
        versions: [1, 2],
      },
    ],
    {
      pinnedTypes: ["pages", "posts"],
      labels: {
        pages: "Pages",
        posts: "Posts",
      },
    },
  );

  expect(rows.map((row) => row.name)).toEqual(["pages", "posts", "authors"]);
  expect(rows[0]?.pinnedIndex).toBe(0);
  expect(rows[1]?.pinnedIndex).toBe(1);
});
