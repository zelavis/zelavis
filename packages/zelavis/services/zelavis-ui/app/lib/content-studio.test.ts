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
        surface: "content-studio",
        metadata: { kind: "content-type" },
      },
      {
        name: "pages",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 2,
        surface: "content-studio",
        metadata: { kind: "content-type" },
      },
      {
        name: "authors",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 1,
        surface: "content-studio",
        metadata: { kind: "content-type" },
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

test("buildContentTypeRows excludes internal platform collections", () => {
  const rows = buildContentTypeRows(
    [
      {
        name: "zelavis_system",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 0,
      },
      {
        name: "posts",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 2,
        surface: "content-studio",
        metadata: { kind: "content-type" },
      },
    ],
    [],
    undefined,
  );

  expect(rows.map((row) => row.name)).toEqual(["posts"]);
});

test("buildContentTypeRows excludes raw database tables created outside Content Studio", () => {
  const rows = buildContentTypeRows(
    [
      {
        name: "posts",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 5,
        surface: "content-studio",
        metadata: { kind: "content-type" },
      },
      {
        name: "raw_analytics",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 1000,
      },
      {
        name: "storage_assets",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 20,
      },
    ],
    [],
    undefined,
  );

  expect(rows.map((row) => row.name)).toEqual(["posts"]);
});

test("buildContentTypeRows excludes collections without metadata", () => {
  const rows = buildContentTypeRows(
    [
      {
        name: "new_posts",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 5,
        surface: "content-studio",
        metadata: { kind: "content-type" },
      },
      {
        name: "no_surface_collection",
        tenantId: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
        documentCount: 10,
        // no surface — not a content type
      },
    ],
    [],
    undefined,
  );

  expect(rows.map((row) => row.name)).toEqual(["new_posts"]);
});
