import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";
import { loadPluginPackage } from "../../../dist/service.js";
import { isDatabaseRuntimeApi } from "../../../dist/app/index.js";

test("the package.json manifest is automatically resolved and validated", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  assert.ok(manifest);
  assert.equal(manifest.name, "@zelavis/app");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.zelavis.kind, "app");
  assert.equal(manifest.zelavis.namespace, "app");
  assert.deepEqual(manifest.zelavis.capabilities, ["app:project", "dashboard:menu", "api:routes"]);
  assert.deepEqual(manifest.zelavis.project.runtimeKinds, ["native"]);
});

test("the service register hook requires a plugin context", async () => {
  const { register } = await import("../dist/index.js");
  assert.throws(() => register(), /plugin execution context/);
});

test("the service loads through the standard plugin loader using package.json as source of truth", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  const service = await loadPluginPackage({
    manifest,
    importer: () => import("../dist/index.js"),
    packageDir: manifest.packageDir,
  });

  assert.equal(service.name, "@zelavis/app");
  assert.equal(service.kind, "app");
  assert.deepEqual(service.project.runtimeKinds, ["native"]);
  assert.deepEqual(service.capabilities, ["app:project", "dashboard:menu", "api:routes"]);
  assert.ok(service.menu);
  assert.equal(service.menu.title, "Overview");
  assert.equal(service.menu.path, "/");
  // The backend stack is composed by the Project runtime, not by this package.
  assert.equal(service.setup, undefined);
});

test("isDatabaseRuntimeApi correctly guards database runtime APIs", () => {
  assert.equal(isDatabaseRuntimeApi(null), false);
  assert.equal(isDatabaseRuntimeApi({}), false);
  assert.equal(
    isDatabaseRuntimeApi({
      forTenant: () => {},
      topology: {},
    }),
    true,
  );
});
