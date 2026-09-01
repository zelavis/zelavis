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

test("every core service reports the kind it is", async () => {
  const services = await runtimeServices();

  // `kind` describes what a service is. A core service composed into the
  // Platform reports "core" whether it was loaded through the plugin loader or
  // constructed directly — otherwise the field says nothing and the dashboard
  // is left inferring core-ness from a hardcoded list of names.
  for (const service of services) {
    assert.equal(service.kind, "core", `${service.name} kind`);
  }
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

test("manifest strictness follows the code, not the kind label", () => {
  const base = {
    name: "@example/thing",
    type: "module",
    exports: { ".": "./index.js" },
  };

  // A non-plugin kind used to skip these checks entirely, so a first-party
  // service had to label itself a plugin to get its manifest validated.
  for (const kind of ["core", "plugin", "provider"]) {
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
