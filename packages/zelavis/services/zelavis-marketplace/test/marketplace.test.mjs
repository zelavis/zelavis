import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";

test("the package.json manifest is automatically resolved and validated", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  assert.ok(manifest);
  assert.equal(manifest.name, "@zelavis/marketplace");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.zelavis.kind, "plugin");
  assert.equal(manifest.zelavis.namespace, "marketplace");
  assert.deepEqual(manifest.zelavis.capabilities, ["dashboard:menu", "marketplace:services"]);
});

test("the service register hook requires a plugin context", async () => {
  const { register } = await import("../dist/index.js");
  assert.equal(typeof register, "function");
  assert.throws(() => register(), /plugin execution context/);
});
