import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { createNodeRuntimeCatalog } from "../dist/adapters/_node-runtime-catalog.js";
import { sealNodeRuntimeArtifact, verifyNodeRuntimeArtifact } from "../dist/adapters/_node-runtime-artifact.js";

// Integrity/selection fixture, not a executable release qualification. Real
// process handovers and staged installed distributions have separate tests.
async function release(directory, version) {
  const root = join(directory, version);
  const files = { "manifest.json": JSON.stringify({ name: "zelavis", version, platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node }),
    "platform/package.json": JSON.stringify({ name: "zelavis", version }), "bin/zelavis": "launcher", "runtime/node/bin/node": "private Node fixture",
    "platform/node_modules/v1/index.js": "dependency one", "platform/node_modules/v2/index.js": "dependency two" };
  for (const name of ["_node-runtime-worker", "_node-runtime-protocol", "_node-platform-engine", "_node-project-engine"]) files[`platform/dist/adapters/${name}.js`] = `// ${version} ${name}`;
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await symlink("v1", join(root, "platform/node_modules/effect"));
  await chmod(join(root, "bin/zelavis"), 0o755);
  await chmod(join(root, "runtime/node/bin/node"), 0o755);
  const artifact = await Effect.runPromise(sealNodeRuntimeArtifact(root));
  return { root: await realpath(root), selected: { version, digest: artifact.digest } };
}

test("both roles resolve the same exactly pinned engine and private Node even when a newer version is installed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-catalog-"));
  try {
    const old = await release(directory, "1.0.0"), next = await release(directory, "2.0.0");
    const catalog = createNodeRuntimeCatalog({ directory, rootOwned: false });
    const listed = await Effect.runPromise(catalog.list());
    assert.deepEqual(listed.map(value => [value.version, value.status]), [["2.0.0", "available"], ["1.0.0", "available"]]);
    assert.deepEqual(await Effect.runPromise(catalog.select("1.0.0")), old.selected);
    assert.deepEqual(await Effect.runPromise(catalog.latest()), next.selected, "new Projects use the latest qualified installed engine");
    for (const role of ["platform", "project"]) {
      const execution = await Effect.runPromise(catalog.resolve(old.selected, role, { role }, { ONLY: "explicit environment" }));
      assert.equal(execution.executable, join(old.root, "runtime/node/bin/node"));
      assert.equal(execution.module, join(old.root, `platform/dist/adapters/_node-${role}-engine.js`));
      assert.deepEqual(execution.environment, { ONLY: "explicit environment" });
      assert.ok(!execution.module.startsWith(next.root));
    }
    for (const value of ["latest", "^1.0.0", "../1.0.0"]) await assert.rejects(Effect.runPromise(catalog.select(value)), /exact version/);
    await assert.rejects(Effect.runPromise(catalog.resolve({ ...old.selected, digest: next.selected.digest }, "project", {}, {})), /exact engine lock/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dependency-link changes and byte changes invalidate an engine lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-integrity-"));
  try {
    const value = await release(directory, "1.0.0");
    await Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected));
    const link = join(value.root, "platform/node_modules/effect");
    await unlink(link); await symlink("v2", link);
    await assert.rejects(Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected)), /dependency-link inventory/);
    await unlink(link); await symlink("v1", link);
    await writeFile(join(value.root, "platform/dist/adapters/_node-project-engine.js"), "modified engine");
    await assert.rejects(Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected)), /file digest mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unqualified protocols, redirected release directories and escaping dependency links are refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-protocol-"));
  try {
    const value = await release(directory, "1.0.0");
    const file = join(value.root, "runtime-artifact.json"), artifact = JSON.parse(await readFile(file, "utf8"));
    artifact.metadata.protocol = "unknown";
    await writeFile(file, JSON.stringify(artifact));
    const catalog = createNodeRuntimeCatalog({ directory, rootOwned: false });
    assert.equal((await Effect.runPromise(catalog.list()))[0].status, "unavailable");
    await assert.rejects(Effect.runPromise(catalog.resolve(value.selected, "project", {}, {})), /handover protocol/);
    await symlink("1.0.0", join(directory, "3.0.0"));
    await assert.rejects(Effect.runPromise(catalog.select("3.0.0")), /never a link/);
    const link = join(value.root, "platform/node_modules/effect");
    await unlink(link); await symlink(process.execPath, link);
    await assert.rejects(Effect.runPromise(sealNodeRuntimeArtifact(value.root)), /escapes its immutable tree/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
