import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { zelavis } from "../dist/index.js";
import { validatePluginPackageManifest } from "../dist/core/service/manifest.js";

async function runtimeServices() {
  const runtime = await zelavis({});
  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/config"),
  );
  return (await response.json()).services;
}

test("every composed service reports the kind it is", async () => {
  const services = await runtimeServices();

  // `kind` describes what a service is. Everything the Platform composes
  // extends it — that is what `plugin` means — except the dashboard, which is
  // the installation's default face rather than an extension of it. Whether
  // the operator composed a service is `scope`, a different question and a
  // different field.
  for (const service of services) {
    assert.equal(
      service.kind,
      service.name === "@zelavis/ui" ? "frontend" : "plugin",
      `${service.name} kind`,
    );
  }
});

test("the dashboard's manifest declares the frontend it is", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../product-services/zelavis-ui/package.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(manifest.zelavis.kind, "frontend");
  // Declared truthfully rather than as a label: the manifest names the bundle
  // this package actually ships, so validating it does not throw.
  assert.deepEqual(manifest.zelavis.frontend, {
    runtime: "static",
    bundle: "build/client",
    mode: "spa",
  });
  assert.ok(manifest.files.includes(manifest.zelavis.frontend.bundle));

  assert.deepEqual(
    validatePluginPackageManifest(manifest).zelavis.frontend,
    manifest.zelavis.frontend,
  );
});

test("the marketplace's declared kind is the one it reports", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        "../product-services/zelavis-marketplace/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const services = await runtimeServices();
  const marketplace = services.find(
    (service) => service.name === "@zelavis/marketplace",
  );

  assert.equal(marketplace.kind, manifest.zelavis.kind);
});

test("an unrecognised kind is refused rather than silently ignored", () => {
  const base = {
    name: "@example/thing",
    type: "module",
    exports: { ".": "./index.js" },
  };

  // The union used to be decorative: `kind` is typed as a bare string on the
  // runtime service, so a typo or a retired kind loaded fine and produced a
  // service that never participated in anything. That is also how the union
  // drifted — it listed five kinds nothing read and omitted `frontend`, the
  // one the Platform branches on most.
  for (const kind of [
    "core",
    "web-app",
    "website",
    "dashboard-extension",
    "provider",
    "template",
    "Plugin",
    "typo",
  ]) {
    assert.throws(
      () => validatePluginPackageManifest({ ...base, zelavis: { kind } }),
      /must be one of app, frontend, plugin/,
      kind,
    );
  }

  for (const kind of ["app", "plugin"]) {
    assert.doesNotThrow(
      () => validatePluginPackageManifest({ ...base, zelavis: { kind } }),
      kind,
    );
  }
});

test("manifest strictness follows the code, not the kind label", () => {
  const base = {
    name: "@example/thing",
    type: "module",
    exports: { ".": "./index.js" },
  };

  // A non-plugin kind used to skip these checks entirely, so a first-party
  // service had to label itself a plugin to get its manifest validated.
  for (const kind of ["app", "plugin"]) {
    assert.throws(
      () => validatePluginPackageManifest({ ...base, type: undefined, zelavis: { kind } }),
      /"type": "module"/,
      `${kind} type`,
    );
    assert.throws(
      () => validatePluginPackageManifest({ ...base, exports: undefined, zelavis: { kind } }),
      /must define "exports"/,
      `${kind} exports`,
    );
    assert.throws(
      () => validatePluginPackageManifest({ ...base, main: "./index.js", zelavis: { kind } }),
      /"main" is not supported/,
      `${kind} main`,
    );
    assert.doesNotThrow(() =>
      validatePluginPackageManifest({ ...base, zelavis: { kind } }),
    );
  }

  // A frontend may be files with no JavaScript entry at all, so the ESM checks
  // do not apply to it. It has its own required fields and fails on those
  // instead — what matters here is that it is never asked for "exports".
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "@example/site",
        zelavis: { kind: "frontend" },
      }),
    (error) => !/"type": "module"|must define "exports"/.test(error.message),
  );
});
