import test from "node:test";
import assert from "node:assert/strict";
import { servicePages, scopedRuntimePath, resolveBrokeredPath } from "../app/service-pages.ts";
const base = "/zelavis/api/v1";
const config = { rootPath: "/zelavis", api: { basePath: base } };
const service = { name: "@fixture/plugin", scope: "extension", status: "installed", apiPath: `${base}/plugins/fixture`, menus: [{ title: "Plugin", path: "/fixture", page: { src: `${base}/runtime/service-page-assets/%40fixture%2Fplugin/dist/dashboard.html` } }], menu: { title: "Ignored", path: "/ignored" } };
test("plural menus are the complete list and trust comes only from runtime scope", () => {
  const pages = servicePages(config, [service]);
  assert.equal(pages.length, 1); assert.equal(pages[0].path, "/fixture"); assert.equal(pages[0].trusted, false); assert.ok(pages[0].src);
  assert.deepEqual(servicePages(config, [{ ...service, menus: [] }]), []);
  assert.deepEqual(servicePages(config, [{ ...service, status: "available" }]), []);
});
test("Project pages and API grants stay under the exact encoded proxy", () => {
  const proxy = `${base}/runtime/projects/project%2Fx/proxy`;
  const scoped = { ...config, api: { basePath: proxy + base } };
  const page = servicePages(scoped, [service], "project/x")[0];
  assert.equal(page.path, "/projects/project%2Fx/fixture");
  assert.equal(page.src, proxy + service.menus[0].page.src);
  assert.equal(page.apiPath, proxy + service.apiPath);
});
test("pages cannot load a different owner's asset or an external document", () => {
  for (const src of ["https://evil.test/page", "//evil.test/page", `${base}/runtime/service-page-assets/other/dist/dashboard.html`, `${base}/runtime/service-page-assets/%40fixture%2Fplugin/dist/%2e%2e/page.html`]) {
    assert.equal(servicePages(config, [{ ...service, menus: [{ title: "Bad", path: "/bad", page: { src } }] }])[0].src, undefined);
  }
});
test("broker rejects namespace escapes, encoded escapes and unsupported origins", () => {
  const grant = { serviceName: service.name, apiPath: service.apiPath };
  assert.equal(resolveBrokeredPath("/orders?limit=2", grant), `${service.apiPath}/orders?limit=2`);
  for (const path of ["../runtime/access", "..%2fruntime/access", "%252e%252e/runtime/access", "%2e%2e/runtime/access", "https://evil.test", "//evil.test", "\\evil.test", "orders#secret", "", "orders\n"]) assert.equal(resolveBrokeredPath(path, grant), undefined, path);
});
test("missing paths have stable derived routes and Project surfaces stay scoped", () => {
  const menus = [{ title: "Tools", items: [{ title: "Settings" }] }];
  assert.deepEqual(servicePages(config, [{ ...service, menus }]).map(page => page.path), ["/fixture-plugin/tools", "/fixture-plugin/tools/settings"]);
  assert.deepEqual(servicePages(config, [{ ...service, scope: "system", menus: [{ title: "Platform", surface: "platform" }] }], "project"), []);
});
