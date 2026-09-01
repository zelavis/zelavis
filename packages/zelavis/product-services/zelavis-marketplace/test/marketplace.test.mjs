import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MARKETPLACE_MANIFEST } from "../dist/manifest.js";
import { MARKETPLACE_PAGE } from "../dist/page.js";

test("the manifest module matches package.json", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  // The loader needs the manifest as a value, so it is duplicated as a module.
  // Drift would mean the marketplace loads under a stale identity.
  for (const field of ["name", "version", "type"]) {
    assert.equal(MARKETPLACE_MANIFEST[field], packageJson[field], field);
  }
  assert.deepEqual(MARKETPLACE_MANIFEST.exports["."], packageJson.exports["."]);
  assert.deepEqual(MARKETPLACE_MANIFEST.zelavis, packageJson.zelavis);
});

test("the page is a complete document", () => {
  // It is loaded into a frame of its own rather than injected into the
  // dashboard, so a fragment would render as a broken page rather than fail.
  assert.match(MARKETPLACE_PAGE, /^<!doctype html>/);
  assert.match(MARKETPLACE_PAGE, /<h1>Marketplace<\/h1>/);
});

test("the service cannot be imported outside a plugin context", async () => {
  // The module contributes its menus by calling the SDK at evaluation time.
  // Importing it directly — composing it as a plain object the way the old
  // in-tree marketplace was — must fail loudly rather than yield a service
  // with no menus.
  await assert.rejects(
    () => import("../dist/index.js"),
    /plugin execution context/,
  );
});
