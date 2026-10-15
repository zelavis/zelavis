import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes, uploadHeaders } from "../app/storage-pages.ts";

test("sizes read in the largest fitting unit", () => {
  assert.equal(formatBytes(undefined), "Unknown");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
});

test("upload metadata and cache policy become the headers the storage service reads", () => {
  assert.deepEqual(uploadHeaders({ label: " Hero ", alt: "", cacheControl: "public, max-age=60" }), { "x-file-meta-label": "Hero", "cache-control": "public, max-age=60" });
  assert.deepEqual(uploadHeaders({}), {});
});

import { moveBefore, orderAssets } from "../app/media-view.ts";

test("gallery order follows the saved order and moves an item before another", () => {
  const files = [{ path: "c" }, { path: "a" }, { path: "b" }];
  assert.deepEqual(orderAssets(files, ["b"]).map(file => file.path), ["b", "a", "c"]);
  assert.deepEqual(moveBefore(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveBefore(["a", "b"], "a", "missing"), ["b", "a"]);
});
