import assert from "node:assert/strict";
import test from "node:test";

import { pinManifest, readBuilds } from "../php-builds/pin.mjs";

const sha = (letter) => letter.repeat(64);
const manifest = () => ({
  zelavis: { project: { install: { runtimes: [
    { command: "php", version: "8.4.23", downloads: { "linux-x86_64": { archive: "https://dl.static-php.dev/old.tar.gz", sha256: sha("1"), maxBytes: 1, executable: "php" } } },
    { command: "php-fpm", version: "8.4.23", downloads: {} },
    { command: "caddy", version: "2.11.7", downloads: {} },
  ] } } },
});
const line = (record) => JSON.stringify({ php: "8.4.24", sapi: "cli", platform: "linux-x86_64", file: "php-8.4.24-cli-linux-x86_64.tar.gz", sha256: sha("a"), bytes: 25_000_000, executable: "php", ...record });

test("a build replaces the matching command's download for its platform and leaves other platforms and programs alone", () => {
  const builds = readBuilds([line({}), line({ sapi: "fpm", executable: "php-fpm", file: "php-8.4.24-fpm-linux-x86_64.tar.gz", sha256: sha("b") })]);
  const { manifest: pinned, changes } = pinManifest(manifest(), builds, "https://mirror.example/php/");
  const [php, fpm, caddy] = pinned.zelavis.project.install.runtimes;
  assert.equal(php.version, "8.4.24");
  assert.deepEqual(php.downloads["linux-x86_64"], { archive: "https://mirror.example/php/8.4.24/php-8.4.24-cli-linux-x86_64.tar.gz", sha256: sha("a"), maxBytes: Math.ceil(25_000_000 * 1.1 / 1024) * 1024, executable: "php" });
  assert.equal(fpm.downloads["linux-x86_64"].sha256, sha("b"));
  assert.deepEqual(caddy, manifest().zelavis.project.install.runtimes[2]);
  assert.equal(changes.length, 2);
});

test("a build of another PHP series changes nothing, and pinning twice changes nothing the second time", () => {
  assert.equal(pinManifest(manifest(), readBuilds([line({ php: "8.3.32", file: "php-8.3.32-cli-linux-x86_64.tar.gz" })]), "https://m.example/php").changes.length, 0);
  const builds = readBuilds([line({})]);
  const once = pinManifest(manifest(), builds, "https://m.example/php").manifest;
  assert.equal(pinManifest(once, builds, "https://m.example/php").changes.length, 0);
});

test("a record that is not what a build produces is refused", () => {
  assert.throws(() => readBuilds([line({ php: "8.4" })]), /exact PHP version/);
  assert.throws(() => readBuilds([line({ platform: "windows-x86_64" })]), /Unknown platform/);
  assert.throws(() => readBuilds([line({ sha256: "nope" })]), /no SHA-256/);
  assert.throws(() => readBuilds([line({ executable: "php-fpm" })]), /not the cli program/);
  assert.throws(() => readBuilds([line({ file: "../escape.tar.gz" })]), /plain file name/);
});
