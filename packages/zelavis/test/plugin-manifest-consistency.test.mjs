import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validatePluginPackageManifest } from "../dist/core/index.js";

/**
 * Every first-party plugin declares itself the same way.
 *
 * These drifted apart once already: two payment gateways shipped no `zelavis`
 * block at all and a `kind` that had been removed, so installing either would
 * have been refused at validation — they only ever worked composed in code.
 */
const PACKAGES = [
  "../../../plugins/ecommerce/package.json",
  "../../../plugins/ecommerce/plugins/stripe/package.json",
  "../../../plugins/ecommerce/plugins/paypal/package.json",
  "../../../plugins/auth-oidc/package.json",
  "../product-services/zelavis-auth/package.json",
  "../product-services/zelavis-marketplace/package.json",
];

test("every first-party plugin manifest validates", async () => {
  for (const path of PACKAGES) {
    const manifest = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    assert.doesNotThrow(
      () => validatePluginPackageManifest(manifest),
      `${manifest.name} does not validate`,
    );
  }
});

test("every first-party plugin declares a kind that still exists", async () => {
  for (const path of PACKAGES) {
    const manifest = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    assert.ok(
      ["plugin", "frontend", "app"].includes(manifest.zelavis?.kind),
      `${manifest.name} declares kind ${manifest.zelavis?.kind}`,
    );
  }
});

test("a plugin declaring capabilities declares them in its manifest", async () => {
  // The loader falls back to the manifest when a service object omits them,
  // so a manifest without them works — until the service is read without
  // being loaded, which is what discovery does when scanning a folder.
  for (const path of [
    "../../../plugins/ecommerce/package.json",
    "../../../plugins/ecommerce/plugins/stripe/package.json",
    "../../../plugins/ecommerce/plugins/paypal/package.json",
    "../../../plugins/auth-oidc/package.json",
  ]) {
    const manifest = JSON.parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    assert.ok(
      Array.isArray(manifest.zelavis.capabilities) &&
        manifest.zelavis.capabilities.length > 0,
      `${manifest.name} declares no capabilities in its manifest`,
    );
  }
});
