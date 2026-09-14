import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginPackageManifest } from "../dist/core/index.js";

/**
 * Every workspace package that declares itself a Zelavis service must be one.
 *
 * Discovered rather than listed. Naming the packages here would put a product
 * catalogue in the Platform's own test suite, and a hand-maintained list is
 * exactly what let two payment gateways ship with no `zelavis` block and a
 * removed `kind` — installing either would have been refused at validation,
 * and nothing noticed because they were only ever composed in code.
 */
const ROOTS = ["../../../plugins", "../services"];

async function findManifests(directory, depth = 0) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const child = join(directory, entry.name);
    try {
      const manifestPath = join(child, "package.json");
      await stat(manifestPath);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.zelavis) found.push({ path: manifestPath, manifest });
    } catch {
      // Not a package; keep looking below it.
    }
    // Nested packages, such as a plugin's own plugins directory.
    if (depth < 2) found.push(...(await findManifests(child, depth + 1)));
  }

  return found;
}

async function manifests() {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const found = [];
  for (const root of ROOTS) {
    found.push(...(await findManifests(join(here, root))));
  }
  return found;
}

test("first-party service manifests are discoverable", async () => {
  const found = await manifests();
  // A guard on the guard: a broken scan would silently assert nothing.
  assert.ok(found.length >= 4, `found only ${found.length} service manifests`);
});

test("every first-party service manifest validates", async () => {
  for (const { manifest } of await manifests()) {
    assert.doesNotThrow(
      () => validatePluginPackageManifest(manifest),
      `${manifest.name} does not validate`,
    );
  }
});

test("every first-party service declares a kind that still exists", async () => {
  for (const { manifest } of await manifests()) {
    assert.ok(
      ["plugin", "frontend", "app"].includes(manifest.zelavis.kind),
      `${manifest.name} declares kind ${manifest.zelavis.kind}`,
    );
  }
});

test("no first-party plugin carries a legacy main", async () => {
  // The contract refuses it, so one that slips in cannot be installed even
  // though everything else about it looks right. A `frontend` is exempt: it
  // may ship files with no JavaScript entry at all, which is why the contract
  // applies the ESM rules to every other kind instead.
  for (const { manifest } of await manifests()) {
    if (manifest.zelavis.kind === "frontend") continue;
    assert.equal(manifest.main, undefined, `${manifest.name} declares main`);
  }
});

test("no first-party plugin carries a legacy entry", async () => {
  for (const { manifest } of await manifests()) {
    assert.equal(manifest.entry, undefined, `${manifest.name} declares entry`);
    assert.equal(manifest.zelavis.entry, undefined, `${manifest.name} declares zelavis.entry`);
  }
});

test("validatePluginPackageManifest rejects legacy entry", () => {
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "test-pkg",
        type: "module",
        exports: "./index.js",
        entry: "./index.js",
        zelavis: { kind: "plugin", namespace: "test" },
      }),
    /entry.*not supported/i,
  );
  assert.throws(
    () =>
      validatePluginPackageManifest({
        name: "test-pkg",
        type: "module",
        exports: "./index.js",
        zelavis: { kind: "plugin", namespace: "test", entry: "./index.js" },
      }),
    /entry.*not supported/i,
  );
});

test("no first-party service carries src/manifest.ts or exports ./manifest", async () => {
  for (const { path: manifestPath, manifest } of await manifests()) {
    const pkgDir = join(manifestPath, "..");
    const srcManifestTs = join(pkgDir, "src", "manifest.ts");
    let hasManifestTs = false;
    try {
      await stat(srcManifestTs);
      hasManifestTs = true;
    } catch {
      hasManifestTs = false;
    }
    assert.equal(hasManifestTs, false, `${manifest.name} must not have src/manifest.ts`);
    if (typeof manifest.exports === "object" && manifest.exports !== null) {
      assert.equal(manifest.exports["./manifest"], undefined, `${manifest.name} must not export ./manifest`);
    }
  }
});
