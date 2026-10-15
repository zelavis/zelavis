import assert from "node:assert/strict";
import test from "node:test";
import { buildContentTypeRows, getContentTypeLabel, reorderPinned, slugifyContentTypeLabel } from "../app/content-studio.ts";

const collections = [
  { name: "articles", surface: "content-studio", documentCount: 3, tenantId: "t" },
  { name: "tags", surface: "content-studio", documentCount: 1, tenantId: "t" },
  { name: "orders", surface: "database", documentCount: 9, tenantId: "t" },
  { name: "zelavis_system", surface: "content-studio", documentCount: 0, tenantId: "t" }
];

test("only content types appear, pinned first in their saved order, then by label", () => {
  const rows = buildContentTypeRows(collections, [{ collection: "articles", activeVersion: 2, versions: [1, 2] }], { pinnedTypes: ["tags"], labels: { articles: "Blog posts" } });
  assert.deepEqual(rows.map(row => row.name), ["tags", "articles"]);
  assert.equal(rows[1].label, "Blog posts");
  assert.equal(rows[1].activeVersion, 2);
  assert.equal(rows[0].activeVersion, null);
});

test("labels and slugs", () => {
  assert.equal(getContentTypeLabel("a", { labels: { a: "  " } }), "a");
  assert.equal(slugifyContentTypeLabel("  Blog Posts! "), "blog-posts");
});

test("a pinned type moves to its target's place", () => {
  assert.deepEqual(reorderPinned(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.equal(reorderPinned(["a", "b"], "a", "x"), undefined);
});
