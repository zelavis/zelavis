import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AUTH_SETTINGS_MANIFEST } from "../dist/manifest.js";

test("the declared manifest matches package.json", async () => {
  // The service is loaded through the ordinary plugin loader, which needs the
  // manifest as a value because a package shipping inside the Platform has no
  // install step to read package.json from. The two drifting apart would load
  // a service describing something this package is not.
  const actual = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );

  assert.equal(AUTH_SETTINGS_MANIFEST.name, actual.name);
  assert.equal(AUTH_SETTINGS_MANIFEST.version, actual.version);
  assert.equal(AUTH_SETTINGS_MANIFEST.type, actual.type);
  assert.deepEqual(AUTH_SETTINGS_MANIFEST.zelavis, actual.zelavis);
  assert.deepEqual(AUTH_SETTINGS_MANIFEST.exports["."], actual.exports["."]);
});
