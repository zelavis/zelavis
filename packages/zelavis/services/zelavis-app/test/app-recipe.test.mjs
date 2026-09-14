import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalPackageManifest } from "../../../dist/adapters/_local-runtime.js";
import {
  zelavisApp,
  zelavisAppService,
  isDatabaseRuntimeApi,
  ZELAVIS_APP_SERVICE_NAME,
  APP_OVERVIEW_MENU,
} from "../dist/index.js";

test("the package.json manifest is automatically resolved and validated", async () => {
  const manifest = resolveLocalPackageManifest(new URL("..", import.meta.url).pathname);
  assert.ok(manifest);
  assert.equal(manifest.name, "@zelavis/app");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.zelavis.kind, "app");
  assert.equal(manifest.zelavis.namespace, "app");
  assert.deepEqual(manifest.zelavis.capabilities, ["app:project", "dashboard:menu", "api:routes"]);
});

test("zelavisApp defines the official App project recipe", () => {
  assert.equal(zelavisApp.name, ZELAVIS_APP_SERVICE_NAME);
  assert.equal(zelavisApp.kind, "app");
  assert.deepEqual(zelavisApp.project.runtimeKinds, ["native"]);
  assert.deepEqual(zelavisApp.capabilities, ["app:project", "dashboard:menu", "api:routes"]);
  assert.deepEqual(zelavisApp.menu, APP_OVERVIEW_MENU);
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

test("setup throws if no database is configured", async () => {
  await assert.rejects(
    () => zelavisApp.setup({ core: {} }),
    /The Zelavis App recipe requires a database/,
  );
});

test("setup mounts database, auth, and workloads runtime services", async () => {
  const fakeDb = {
    forTenant: () => ({}),
    topology: {},
  };
  const result = await zelavisApp.setup({
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

test("zelavisAppService supports disabling auth and workloads", async () => {
  const fakeDb = {
    forTenant: () => ({}),
    topology: {},
  };
  const customService = zelavisAppService({
    name: "custom-app",
    database: fakeDb,
    auth: false,
    workloads: false,
  });

  assert.equal(customService.name, "custom-app");
  const result = await customService.setup({ core: {} });
  assert.equal(result.runtimeServices.length, 1);
  assert.equal(result.runtimeServices[0].name, "@zelavis/db");
});
