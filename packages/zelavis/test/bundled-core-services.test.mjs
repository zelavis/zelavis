import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveBundledServiceDirectory,
  resolveLocalPackageManifest,
} from "../dist/adapters/_local-runtime.js";

const distributionRoot = fileURLToPath(new URL("..", import.meta.url));

function bundledNames() {
  return JSON.parse(
    readFileSync(join(distributionRoot, "package.json"), "utf-8"),
  );
}

test("a bundled package is found in the distribution's own services folder", () => {
  for (const name of [
    "@zelavis/app",
    "@zelavis/auth",
    "@zelavis/marketplace",
    "@zelavis/ui",
  ]) {
    const directory = resolveBundledServiceDirectory(name);

    assert.ok(
      directory,
      `${name} ships in this distribution but was not found in services/`,
    );

    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf-8"),
    );
    assert.equal(manifest.name, name);
  }
});

test("a name that does not ship here resolves to nothing", () => {
  assert.equal(resolveBundledServiceDirectory("@acme/not-bundled"), undefined);
  assert.equal(resolveBundledServiceDirectory(""), undefined);
});

test("a bundled package's manifest resolves without being installed", () => {
  // The point of the bundled lookup: these names are no longer declared as
  // dependencies, so import.meta.resolve cannot find them in node_modules.
  // Resolution has to come from the folder that ships beside the code.
  for (const name of ["@zelavis/app", "@zelavis/marketplace"]) {
    const manifest = resolveLocalPackageManifest(name);

    assert.ok(manifest, `${name} did not resolve from the distribution`);
    assert.equal(manifest.name, name);
    assert.equal(manifest.packageDir, resolveBundledServiceDirectory(name));
  }
});

test("the distribution does not depend on its own bundled services", () => {
  // Declaring them as registry dependencies is what forced them to be
  // published separately, and what made a standalone install impossible.
  const manifest = bundledNames();
  const declared = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };

  for (const name of [
    "@zelavis/app",
    "@zelavis/auth",
    "@zelavis/marketplace",
    "@zelavis/ui",
  ]) {
    assert.equal(
      declared[name],
      undefined,
      `${name} is bundled in services/ and must not also be a dependency`,
    );
  }
});
