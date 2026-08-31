import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const distribution = new URL("../", import.meta.url);

test("release configuration pins a supported Node runtime", async () => {
  const release = JSON.parse(await readFile(new URL("release.json", distribution), "utf8"));
  assert.match(release.nodeVersion, /^24\./);
  assert.equal(release.minimumNodeMajor, 24);
  assert.match(release.aptRepository, /^https:\/\//);
});

test("install and packaging shell scripts have valid syntax", () => {
  for (const path of [
    "installers/install.sh",
    "installers/archive-install.sh",
    "scripts/build-all.sh",
    "scripts/build-apt-repository.sh",
    "runtime/zelavis",
  ]) {
    execFileSync("sh", ["-n", new URL(path, distribution).pathname]);
  }
});

test("APT source binds the repository to its dedicated keyring", async () => {
  const source = await readFile(new URL("apt/zelavis.sources", distribution), "utf8");
  assert.match(source, /Signed-By: \/usr\/share\/keyrings\/zelavis-archive-keyring\.gpg/);
  assert.match(source, /URIs: https:\/\/apt\.zelavis\.com/);
});

test("the Debian package installs the native WordPress host stack", async () => {
  const builder = await readFile(new URL("scripts/build-deb.mjs", distribution), "utf8");
  for (const dependency of ["nginx", "php-fpm", "php-mysql", "mariadb-server-core", "mariadb-client-core"]) {
    assert.match(builder, new RegExp(`Depends:.*\\b${dependency}\\b`));
  }
});

test("the quick archive installer verifies its payload", async () => {
  const installer = await readFile(new URL("installers/install.sh", distribution), "utf8");
  assert.match(installer, /\.sha256/);
  assert.match(installer, /checksum verification failed/);
});
