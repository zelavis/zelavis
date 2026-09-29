import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackageDirectoryBundleStore } from "../dist/adapters/_local-runtime.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zelavis-bundle-"));
  test.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "pkg");
  await mkdir(join(packageDirectory, "dist"), { recursive: true });
  await writeFile(join(packageDirectory, "dist", "index.html"), "<p>ok</p>");
  await writeFile(join(packageDirectory, "package.json"), "{}");
  await writeFile(join(root, "secret.txt"), "secret");
  await symlink(join(root, "secret.txt"), join(packageDirectory, "dist", "link.txt"));
  const store = createPackageDirectoryBundleStore(new Map([["@acme/site", packageDirectory]]));
  return (path, serviceName = "@acme/site") => store.read({ serviceName, bundle: "dist" }, path);
}

test("a package bundle serves its files with a content type", async () => {
  const read = await fixture();
  const asset = await read("/index.html");
  assert.equal(new TextDecoder().decode(asset.body), "<p>ok</p>");
  assert.match(asset.contentType, /text\/html/);
});

test("a package bundle cannot read outside its bundle directory", async () => {
  const read = await fixture();
  assert.equal(await read("../package.json"), undefined);
  assert.equal(await read("/../../secret.txt"), undefined);
  assert.equal(await read("link.txt"), undefined, "a symlink must not lead out of the package");
  assert.equal(await read("missing.html"), undefined);
});

test("a package this host did not discover is not served", async () => {
  const read = await fixture();
  assert.equal(await read("/index.html", "@acme/other"), undefined);
});
