import assert from "node:assert/strict";
import test from "node:test";
import manifest from "@zelavis/ui/package.json" with { type: "json" };
import { zelavisUiFrontend } from "@zelavis/ui/frontend";
import * as dashboard from "@zelavis/ui/service";
import { zelavis as sdk, createZelavisClient } from "../dist/sdk/fetch.js";
import { loadPluginPackage } from "../dist/service.js";
import { zelavis as boot } from "../dist/index.js";
import { createZelavisAuthSettingsService } from "../dist/platform/auth-settings.js";
import { createZelavisMarketplaceService } from "../dist/platform/marketplace.js";

const configuration = rootPath => ({ rootPath, createRuntimeConfig: async () => ({ rootPath }) });

test("UI identity is loaded from its manifest and behavior is registered through the SDK", async () => {
  assert.equal(dashboard.createZelavisDashboardService, undefined);
  assert.equal(dashboard.dashboardService, undefined);
  assert.equal(dashboard.default, undefined);
  assert.throws(() => dashboard.register(), /plugin execution context/);
  const first = await zelavisUiFrontend(configuration("/first"));
  const second = await zelavisUiFrontend(configuration("/second"));
  for (const frontend of [first, second]) {
    assert.equal(frontend.service.name, manifest.name);
    assert.equal(frontend.service.version, manifest.version);
    assert.equal(frontend.service.kind, manifest.zelavis.kind);
    assert.equal(frontend.service.namespace, manifest.zelavis.namespace);
    assert.equal(frontend.service.app.bundle, manifest.zelavis.frontend.bundle);
    assert.equal(frontend.service.scope, "system");
    assert.equal(frontend.service.menus.length, 1);
    assert.equal(frontend.service.api.v1.length, 0);
  }
  const render = frontend => frontend.service.app.shell.render({ path: "projects", request: new Request("http://localhost/") });
  const [left, right] = await Promise.all([render(first), render(second)]);
  assert.equal(left.status, 200);
  assert.match(left.body, /"rootPath":"\/first"/);
  assert.match(right.body, /"rootPath":"\/second"/);
  assert.doesNotMatch(left.body, /"rootPath":"\/second"/);
});

test("cached first-party modules register menus for each independent load", async () => {
  for (const load of [createZelavisAuthSettingsService, createZelavisMarketplaceService]) {
    const first = await load();
    const second = await load();
    assert.notEqual(first, second);
    assert.ok(first.menus.length > 0);
    assert.deepEqual(second.menus, first.menus);
    assert.notEqual(second.menus, first.menus);
  }
});

test("SDK frontend behavior validates its kind and cannot override manifest metadata", async () => {
  const load = (input, behavior) => loadPluginPackage({ manifest: input, importer: async () => ({ register() {
    sdk.frontend.configure(behavior);
  } }) });
  await assert.rejects(load({ name: "@test/plugin", type: "module", exports: "./index.js", zelavis: { namespace: "example", kind: "plugin" } }, {}), /static frontend manifest/);
  await assert.rejects(load(manifest, { bundle: "elsewhere" }), /metadata belongs in package.json/);
  await assert.rejects(load(manifest, { shell: {} }), /render function/);
  await assert.rejects(loadPluginPackage({ manifest, importer: async () => ({ default: { name: "other" } }) }), /not a module export/);
  await assert.rejects(loadPluginPackage({ manifest, importer: async () => ({ default: { api: {} } }) }), /register APIs/);
});

test("UI shell mounting remains separate from SDK-generated namespaced APIs", async (t) => {
  const runtime = await boot({ rootPath: "/custom", frontend: async context => {
    const frontend = await zelavisUiFrontend(context);
    const service = await loadPluginPackage({ manifest, scope: "system", importer: async () => ({ register() {
      dashboard.register(context);
      sdk.createAPI({ health: { list() { return { ready: true }; } } });
    } }) });
    return { ...frontend, service };
  } });
  t.after(() => runtime.close());
  const fetcher = (url, init) => runtime.fetch(new Request(url, init), { principal: { id: "owner", type: "user", permissions: ["*"] } });
  const page = await fetcher("http://localhost/custom/projects");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /__ZELAVIS_RUNTIME_CONFIG__/);
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/custom", fetch: fetcher });
  assert.deepEqual(await client.plugins.ui.health.list(), { ready: true });
  assert.equal((await fetcher("http://localhost/custom/health")).headers.get("content-type").includes("text/html"), true);
  assert.equal((await fetcher("http://localhost/custom/api/not-found")).status, 404);
});

test("an executable frontend uses SDK registration through the generic service loader", async () => {
  const { loadService } = await import("../dist/service.js");
  const service = await loadService(manifest.name, {
    manifest, configuration: configuration("/installed"), scope: "system",
    importer: async () => dashboard,
  });
  assert.equal(service.menus.length, 1);
  const page = await service.app.shell.render({ path: "", request: new Request("http://localhost/") });
  assert.match(page.body, /"rootPath":"\/installed"/);
});

test("concurrent package loads retain their own namespaces and configuration", async () => {
  const loaded = await Promise.all(["left", "right"].map(namespace => loadPluginPackage({
    manifest: { name: `@test/${namespace}`, type: "module", exports: "./index.js", zelavis: { namespace, kind: "plugin" } },
    importer: async () => {
      await new Promise(resolve => setTimeout(resolve, namespace === "left" ? 5 : 1));
      return { async register() {
        await new Promise(resolve => setTimeout(resolve, 1));
        sdk.createAPI({ items: { list() { return namespace; } } });
      } };
    },
  })));
  assert.equal(loaded[0].api.v1[0].id, "left.items.list");
  assert.equal(loaded[1].api.v1[0].id, "right.items.list");
  assert.equal(sdk.context(), undefined);
});
