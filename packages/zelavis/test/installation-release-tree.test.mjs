import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleNpmReleaseTree } from "../dist/adapters/_release-tree.js";

/** What install.sh hands the installer: the private Node and the npm package. */
async function prepared(t, { version = "9.9.9", linkNode = true, privateNode = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-release-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime/node/bin"), { recursive: true });
  if (privateNode) await copyFile(process.execPath, join(root, "runtime/node/bin/node"));
  else if (linkNode) await symlink(process.execPath, join(root, "runtime/node/bin/node"));
  await mkdir(join(root, "platform"), { recursive: true });
  await writeFile(join(root, "platform/package.json"), JSON.stringify({ name: "zelavis", version }));
  await mkdir(join(root, "platform/dist/adapters"), { recursive: true });
  for (const module of ["_node-runtime-worker", "_node-runtime-protocol", "_node-platform-engine", "_node-project-engine"]) await writeFile(join(root, `platform/dist/adapters/${module}.js`), `// release fixture ${module}`);
  return root;
}

const options = { nodeVersion: process.versions.node, installTraefik: async () => true };
async function assemblePrivate(root, target) {
  const script = `import { assembleNpmReleaseTree } from ${JSON.stringify(new URL("../dist/adapters/_release-tree.js", import.meta.url).href)};
    const [root, options] = JSON.parse(process.argv[1]);
    const traefik = [];
    const result = await assembleNpmReleaseTree(root, { ...options, installTraefik: async (output, version, target) => {
      if (options.platform === "darwin") throw new Error("Traefik must not be fetched on macOS.");
      traefik.push({ output, version, target }); return true;
    }});
    console.log(JSON.stringify({ ...result, traefik }));`;
  const result = await promisify(execFile)(join(root, "runtime/node/bin/node"), ["--input-type=module", "-e", script, JSON.stringify([root, { ...target, nodeVersion: process.versions.node }])]);
  return JSON.parse(result.stdout);
}

test("a prepared Node and package become a release tree built from the package's own assets", async (t) => {
  const root = await prepared(t, { privateNode: true });
  const { version, traefik } = await assemblePrivate(root, { platform: "linux", architecture: "x64" });
  assert.equal(version, "9.9.9");
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  assert.deepEqual({ name: manifest.name, version: manifest.version, platform: manifest.platform, architecture: manifest.architecture, bundled: manifest.edge.bundled }, { name: "zelavis", version: "9.9.9", platform: "linux", architecture: "x64", bundled: true });
  assert.equal(traefik.length, 1);
  assert.deepEqual(traefik[0].target, { platform: "linux", architecture: "x64" });
  assert.equal((await stat(join(root, "bin/zelavis"))).mode & 0o111, 0o111);
  const share = await readdir(join(root, "share"));
  for (const file of ["zelavis.service", "zelavis@.service", "zelavis-agent.service", "zelavis-agent@.service", "zelavis-host-agent.service", "zelavis-host-agent@.service", "zelavis-traefik.service", "zelavis-update.service", "zelavis-update.path", "zelavis.socket", "traefik.yml", "uninstall.sh"]) assert.ok(share.includes(file), file);
  // Operations are plain manifests beside their artifacts: no signature, no key.
  const operations = await readdir(join(root, "operations"));
  assert.ok(operations.includes("zelavis.host-report"));
  const operation = JSON.parse(await readFile(join(root, "operations/zelavis.host-report/v1/manifest.json"), "utf8"));
  assert.match(operation.sha256, /^[a-f0-9]{64}$/);
  assert.equal(operation.signature, undefined);
  assert.equal(operation.keyId, undefined);
  assert.ok((await lstat(join(root, "operations/zelavis.host-report/v1/artifact"))).isFile());
  assert.equal((await stat(join(root, "operations/zelavis.packages-install/v1/artifact"))).mode & 0o777, 0o755, "npm transport modes are repaired during installed-tree assembly");
  const artifact = JSON.parse(await readFile(join(root, "runtime-artifact.json"), "utf8"));
  assert.equal(artifact.metadata.protocol, "zelavis-runtime/1");
  assert.match(artifact.fileDigests["runtime/node/bin/node"], /^sha256:[a-f0-9]{64}$/);
  assert.equal(artifact.signature, undefined);
});

test("macOS trees carry no Traefik files and download nothing", async (t) => {
  const root = await prepared(t, { privateNode: true });
  await assemblePrivate(root, { platform: "darwin", architecture: "arm64" });
  const share = await readdir(join(root, "share"));
  assert.ok(!share.includes("zelavis-traefik.service") && !share.includes("traefik.yml"));
  assert.equal(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).edge.bundled, false);
});

test("the installer refuses a tree that does not run on its own pinned Node, or lacks the package", async (t) => {
  const foreign = await prepared(t, { linkNode: false });
  await writeFile(join(foreign, "runtime/node/bin/node"), "#!/bin/sh\n", { mode: 0o755 });
  await assert.rejects(assembleNpmReleaseTree(foreign, options), /prepared private Node/);
  const wrongVersion = await prepared(t);
  await assert.rejects(assembleNpmReleaseTree(wrongVersion, { ...options, nodeVersion: "1.0.0" }), /prepared private Node 1\.0\.0/);
  const empty = await mkdtemp(join(tmpdir(), "zelavis-release-tree-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(assembleNpmReleaseTree(empty, options), /ENOENT|package/);
  const impostor = await prepared(t);
  await writeFile(join(impostor, "platform/package.json"), JSON.stringify({ name: "not-zelavis", version: "1.0.0" }));
  await assert.rejects(assembleNpmReleaseTree(impostor, options), /does not hold the zelavis package/);
  await assert.rejects(assembleNpmReleaseTree(await prepared(t), { ...options, platform: "win32" }), /Unsupported installation target/);
});
