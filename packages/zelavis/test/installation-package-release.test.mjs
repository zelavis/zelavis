import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquirePackageRelease, packageReleaseLocation } from "../dist/adapters/_package-release.js";

async function fixture(t, options = {}) {
  const temporaryParent = await mkdtemp(join(tmpdir(), "zelavis-acquisition-"));
  t.after(() => rm(temporaryParent, { recursive: true, force: true }));
  const location = packageReleaseLocation("2.0.0-alpha.5", "linux", "x64");
  const source = join(temporaryParent, location.name);
  await mkdir(join(source, "runtime/node/bin"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ name: "zelavis", version: options.version ?? "2.0.0-alpha.5", platform: "linux", architecture: "x64" }));
  if (options.nodeLink) await symlink(process.execPath, join(source, "runtime/node/bin/node"));
  else await writeFile(join(source, "runtime/node/bin/node"), "fixture private runtime", { mode: 0o755 });
  const file = join(temporaryParent, "fixture.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", temporaryParent, location.name]);
  if (options.unsafe) {
    await writeFile(join(temporaryParent, "outside"), "not release content");
    execFileSync("tar", ["-czf", file, "-C", temporaryParent, location.name, "outside"]);
  }
  const archive = await readFile(file);
  const digest = createHash("sha256").update(archive).digest("hex");
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (options.missing) return new Response("not published", { status: 404 });
    if (url === location.metadata) return Response.json({ name: "zelavis", version: options.metadataVersion ?? "2.0.0-alpha.5", dist: { integrity: "sha512-" + Buffer.alloc(64).toString("base64") } });
    if (url.endsWith("/SHA256SUMS")) return new Response(`${options.corrupt ? "0".repeat(64) : digest}  ${location.name}.tar.gz\n`);
    return new Response(archive);
  };
  return { options: { temporaryParent, fetch, platform: "linux", architecture: "x64" }, calls, temporaryParent, source };
}

test("exact-version acquisition verifies and cleans a prebuilt production tree", async (t) => {
  const fixtureData = await fixture(t);
  const acquired = await acquirePackageRelease("2.0.0-alpha.5", fixtureData.options);
  assert.equal(JSON.parse(await readFile(join(acquired.source, "manifest.json"), "utf8")).name, "zelavis");
  assert.equal(fixtureData.calls.length, 3);
  assert.ok(fixtureData.calls.every((url) => url.startsWith("https://")));
  assert.match(fixtureData.calls[1], /zelavis%402\.0\.0-alpha\.5/);
  await acquired.cleanup();
  assert.deepEqual(await readdir(fixtureData.temporaryParent), ["fixture.tar.gz", "zelavis-2.0.0-alpha.5-linux-x64"]);
});

for (const [name, options, expected] of [
  ["checksum mismatch", { corrupt: true }, /checksum|SHA-256/i],
  ["wrong npm metadata", { metadataVersion: "2.0.0" }, /published package metadata/],
  ["unsafe archive root", { unsafe: true }, /Unsafe release archive member/],
  ["wrong release version", { version: "1.0.0" }, /identity/],
  ["external private Node symlink", { nodeLink: true }, /escapes its verified tree/],
  ["unpublished exact release", { missing: true }, /matching release must be published/],
]) test(`acquisition refuses ${name} before installation and removes scratch state`, async (t) => {
  const fixtureData = await fixture(t, options);
  await assert.rejects(acquirePackageRelease("2.0.0-alpha.5", fixtureData.options), expected);
  assert.ok(!(await readdir(fixtureData.temporaryParent)).some((name) => name.startsWith("zelavis-package-install-")));
});

test("tags, ranges, path injection and unsupported targets refuse before fetching", () => {
  for (const version of ["latest", "^2.0.0", "2.0.0/../foo", "2.0.0;sh"]) assert.throws(() => packageReleaseLocation(version, "linux", "x64"), /exact version/);
  assert.throws(() => packageReleaseLocation("2.0.0", "win32", "x64"), /Unsupported/);
});

test("published checksum helpers and pins are generated from the one distribution source", async () => {
  for (const [asset, source] of [["runtime-assets.mjs", "scripts/runtime-assets.mjs"], ["release.json", "release.json"]]) {
    assert.equal(await readFile(new URL(`../dist/installation-assets/${asset}`, import.meta.url), "utf8"), await readFile(new URL(`../../../distribution/${source}`, import.meta.url), "utf8"));
  }
});
