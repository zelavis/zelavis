import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { WORDPRESS_ARCHIVE_SHA256, WORDPRESS_RELEASE } from "../dist/release.js";
import { WORDPRESS_APP_NAME, createProjectRuntime, wordpressRelease } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the package version is semver and names the WordPress release it installs", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(wordpressRelease("7.1.0"), "7.1", "WordPress names its x.y.0 releases x.y");
  assert.equal(wordpressRelease("6.9.4"), "6.9.4");
  assert.equal(wordpressRelease(manifest.version).includes(".0"), false);
  for (const bad of ["7.1", "7", "7.1.0-rc1", "v7.1.0", "7.1.0.0", "", "../7.1.0", "7.1.x"]) {
    assert.throws(() => wordpressRelease(bad), /Invalid locked WordPress version/, bad);
  }
});

test("the manifest declares a recipe that ships its own runtime, and the runtime exists", async () => {
  assert.equal(manifest.name, WORDPRESS_APP_NAME);
  assert.equal(manifest.zelavis.kind, "app");
  assert.deepEqual(manifest.zelavis.project.runtimeKinds, ["native"]);
  assert.equal(manifest.zelavis.project.runtime, "./dist/runtime.js");
  await access(new URL("../dist/runtime.js", import.meta.url));
  assert.ok(manifest.files.includes("dist"), "the runtime is part of what is published and frozen");
});

test("its runtime is the native WordPress driver, configured by the host's options", () => {
  const agent = { start: async () => { throw new Error("not started"); } };
  const driver = createProjectRuntime({ directory: "/tmp/zv-wp-test", agent, options: { startupTimeoutMs: 1234, user: "www" } });
  assert.equal(driver.name, "native-wordpress");
  assert.deepEqual([...driver.runtimeKinds], ["native"]);
  assert.match(driver.capabilities({}).description, /WordPress/);
});

test("the pinned release is the one the package version names, with a SHA-256 to check it against", () => {
  assert.equal(WORDPRESS_RELEASE, wordpressRelease(manifest.version));
  assert.match(WORDPRESS_ARCHIVE_SHA256, /^[0-9a-f]{64}$/);
});
