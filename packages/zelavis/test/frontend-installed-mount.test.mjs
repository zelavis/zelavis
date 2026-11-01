import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { readFrontendManifest, toServiceAppDefinition } from "../dist/core/service/frontend.js";
import { injectFrontendBasePath, rewriteBundleAssetBase } from "../dist/service-app.js";
// The generic installable-frontend mechanism (a manifest-declared static bundle, mounted wherever the Platform puts
// it) is exercised with the React dashboard's built shell, kept as a fixture: that dashboard declared exactly this
// contract. The Fuzor dashboard is a bundled frontend with its own adapter and is covered by its package's tests.
const frontendManifest = {
  name: "@test/installable-frontend",
  version: "1.0.0",
  zelavis: { kind: "frontend", namespace: "installable", frontend: { runtime: "static", bundle: "build/client", mode: "spa", assetBase: "/assets/", basePathGlobal: "__ZELAVIS_BASE_PATH__" } },
};
const shell = await readFile(new URL("./fixtures/installable-frontend-shell.html", import.meta.url), "utf8");

async function dashboardManifest() {
  return frontendManifest;
}

function dashboardIndexHtml() {
  return shell;
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
