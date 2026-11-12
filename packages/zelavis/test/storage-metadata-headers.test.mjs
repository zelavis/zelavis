// An upload's metadata arrives as headers. The Project Gateway strips every x-zelavis-* request header, so the
// dashboard (which reaches a Project through the Platform) sends it as x-file-meta-*; both are read the same way.
import assert from "node:assert/strict";
import test from "node:test";
import { readStorageMetadataHeaders } from "../dist/platform/storage.js";

test("metadata headers are read under either prefix", () => {
  assert.deepEqual(readStorageMetadataHeaders(new Headers({ "x-zelavis-meta-label": "Hero", "X-File-Meta-Alt": "A hero" })), { label: "Hero", alt: "A hero" });
});

test("unrelated headers and empty names are ignored", () => {
  assert.equal(readStorageMetadataHeaders(new Headers({ "content-type": "text/plain", "x-file-meta-": "x" })), undefined);
  assert.equal(readStorageMetadataHeaders(undefined), undefined);
});
