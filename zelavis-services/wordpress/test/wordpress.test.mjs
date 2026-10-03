import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import { WORDPRESS_ARCHIVE_SHA256, WORDPRESS_RELEASE } from "../dist/release.js";
import { WORDPRESS_APP_NAME, createProjectRuntime } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("recipe revisions are independent from the pinned WordPress release", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.match(WORDPRESS_RELEASE, /^\d+\.\d+(?:\.\d+)?$/);
  assert.deepEqual(manifest.zelavis.project.hostPackages, ["wordpress-stack"]);
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

test("the software archive has a pinned SHA-256", () => {
  assert.match(WORDPRESS_ARCHIVE_SHA256, /^[0-9a-f]{64}$/);
});
