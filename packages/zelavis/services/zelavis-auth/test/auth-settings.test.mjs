import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";

test("the package.json manifest is automatically resolved and validated", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  assert.ok(manifest);
  assert.equal(manifest.name, "@zelavis/auth");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.zelavis.kind, "plugin");
  assert.equal(manifest.zelavis.namespace, "auth");
  assert.deepEqual(manifest.zelavis.capabilities, ["dashboard:menu"]);
});

test("the service cannot be imported outside a plugin context", async () => {
  await assert.rejects(
    () => import("../dist/index.js"),
    /plugin execution context/,
  );
});

test("the auth settings page is a complete document that styles itself from the Platform", async () => {
  const page = await readFile(
    new URL("../dashboard/auth.html", import.meta.url),
    "utf8",
  );
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /<title>Auth<\/title>/i);
  assert.match(page, /service-page\.css/);
  assert.match(page, /const OWNER = "zelavis\/auth"/);
});
