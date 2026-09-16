import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";
import { loadPluginPackage } from "../../../dist/service.js";
import { isDatabaseRuntimeApi, mountAppServices } from "../../../dist/app/index.js";

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
  assert.equal(typeof service.setup, "function");
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

test("service.setup throws if no database is configured", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  const service = await loadPluginPackage({
    manifest,
    importer: () => import("../dist/index.js"),
    packageDir: manifest.packageDir,
  });

  await assert.rejects(
    () => service.setup({ core: {} }),
    /The Zelavis App recipe requires a database/,
  );
});

test("service.setup mounts database, auth, and workloads runtime services", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  const service = await loadPluginPackage({
    manifest,
    importer: () => import("../dist/index.js"),
    packageDir: manifest.packageDir,
  });

  const fakeDb = {
    forTenant: () => ({}),
    topology: {},
  };
  const result = await service.setup({
    core: { database: fakeDb },
    platform: { metadata: { projectId: "test-proj" } },
    registry: [],
  });

  assert.ok(Array.isArray(result.runtimeServices));
  assert.equal(result.runtimeServices.length, 3);
  const serviceNames = result.runtimeServices.map((s) => s.name);
  assert.ok(serviceNames.includes("@zelavis/db"));
  assert.ok(serviceNames.includes("zelavis/auth"));
  assert.ok(serviceNames.includes("@zelavis/workloads"));
});

test("mountAppServices supports disabling auth and workloads via options", async () => {
  const fakeDb = {
    forTenant: () => ({}),
    topology: {},
  };
  const result = await mountAppServices(
    { core: { database: fakeDb } },
    { auth: false, workloads: false },
  );

  assert.equal(result.runtimeServices.length, 1);
  assert.equal(result.runtimeServices[0].name, "@zelavis/db");
});

test("App setup returns its services once without also adding them through context", async () => {
  let added = 0;
  const result = await mountAppServices({
    core: { database: { forTenant() {}, topology: {} } },
    addServices(services) { added += services.length; },
  }, { auth: false, workloads: false });
  assert.equal(added, 0);
  assert.equal(result.runtimeServices.length, 1);
});
