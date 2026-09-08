import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readFrontendManifest, toServiceAppDefinition } from "../dist/core/service/frontend.js";
import { injectFrontendBasePath, rewriteBundleAssetBase } from "../dist/service-app.js";
// The committed copy of the built `index.html`. Reading `build/client`
// directly would tie these tests to a full `react-router build`, which the
// runtime test job does not run — the dashboard e2e job builds that.
import { embeddedDashboardShell } from "@zelavis/ui/dashboard-assets";

async function dashboardManifest() {
  return JSON.parse(
    await readFile(
      new URL("../services/zelavis-ui/package.json", import.meta.url),
      "utf8",
    ),
  );
}

function dashboardIndexHtml() {
  return embeddedDashboardShell;
}

test("the dashboard bundle carries the script that applies its mount", async () => {
  const html = dashboardIndexHtml();

  // Without this the bundle is built for one path and the Platform has to
  // rewrite a router literal on the way out — which is what made the dashboard
  // suppliable but not installable.
  assert.match(html, /data-zelavis-runtime-base-path/u);
  assert.match(html, /__ZELAVIS_BASE_PATH__/u);
  // The build stays base-agnostic; the mount is applied at runtime.
  assert.match(html, /"basename":"\/"/u);
});

test("serving the dashboard purely from its manifest declares the mount", async () => {
  const app = toServiceAppDefinition(
    readFrontendManifest(await dashboardManifest()),
    { mount: "/admin" },
  );
  assert.equal(app.basePathGlobal, "__ZELAVIS_BASE_PATH__");
  assert.equal(app.assetBase, "/assets/");

  const source = dashboardIndexHtml();
  const encode = (text) => new TextEncoder().encode(text);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const contentType = "text/html; charset=utf-8";

  // Exactly what the generic frontend path does: rewrite the asset base, then
  // declare the mount. No knowledge of React Router anywhere in it.
  const served = decode(
    injectFrontendBasePath(
      rewriteBundleAssetBase(encode(source), contentType, app.assetBase, app.mount),
      contentType,
      app.basePathGlobal,
      app.mount,
    ),
  );

  assert.match(served, /window\["__ZELAVIS_BASE_PATH__"\]="\/admin"/u);
  assert.match(served, /"\/admin\/assets\//u);
  // No trailing slash: React Router requires the URL to start with the
  // basename, and `/admin/` does not match a request for `/admin`.
  assert.ok(!served.includes('window["__ZELAVIS_BASE_PATH__"]="/admin/"'));
});
