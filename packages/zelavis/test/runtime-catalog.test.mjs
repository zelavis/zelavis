import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm, realpath, stat, utimes } from "node:fs/promises";
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
    "platform/package.json": JSON.stringify({ name: "zelavis", version }),
    "platform/services/zelavis-app/package.json": JSON.stringify({ name: "@zelavis/app", version, type: "module", exports: "./dist/index.js", zelavis: { kind: "app", namespace: "app", project: { runtimeKinds: ["native"] } } }), "bin/zelavis": "launcher", "runtime/node/bin/node": "private Node fixture",
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

test("an exact engine selects its own verified App recipe and refuses altered recipe bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-recipe-"));
  try {
    const old = await release(directory, "1.0.0"); await release(directory, "2.0.0");
    const catalog = createNodeRuntimeCatalog({ directory, rootOwned: false });
    const app = await Effect.runPromise(catalog.app("1.0.0"));
    assert.equal(app.engine.version, "1.0.0"); assert.equal(app.recipe.version, "1.0.0");
    assert.equal(app.packageDirectory, join(old.root, "platform/services/zelavis-app"));
    await writeFile(join(app.packageDirectory, "package.json"), "{}");
    await assert.rejects(Effect.runPromise(catalog.app("1.0.0")), /file digest mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a release declares the data format it writes, and one that declares none is read as the format every earlier release wrote", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-format-"));
  try {
    const { CURRENT_FORMAT } = await import("../dist/db/kv-store.js");
    const { root } = await release(directory, "3.0.0");
    const catalog = createNodeRuntimeCatalog({ directory, rootOwned: false });
    assert.equal(await Effect.runPromise(catalog.dataFormat("3.0.0")), CURRENT_FORMAT, "a newly sealed artifact declares this build's format");
    const file = join(root, "runtime-artifact.json");
    const artifact = JSON.parse(await readFile(file, "utf8"));
    delete artifact.metadata.dataFormat;
    await writeFile(file, `${JSON.stringify(artifact)}\n`);
    assert.equal(await Effect.runPromise(catalog.dataFormat("3.0.0")), 2, "alpha.5 to alpha.42 declared nothing and wrote format 2");
    await assert.rejects(Effect.runPromise(catalog.dataFormat("latest")), /exact version/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a bound App starts on the engine that wrote its data across a layout change, and follows the Platform otherwise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-bound-engine-"));
  try {
    const { chooseBoundEngine } = await import("../dist/adapters/_node-bound-engine.js");
    const { ZELAVIS_VERSION } = await import("../dist/version.js");
    const older = await release(directory, "1.0.0");
    await release(directory, ZELAVIS_VERSION);
    const catalog = createNodeRuntimeCatalog({ directory, rootOwned: false });
    const journalFile = join(directory, "runtime-handover.json");
    const layoutRoot = directory;
    const select = () => Effect.runPromise(chooseBoundEngine({ journalFile, layoutRoot, catalog }));
    const layout = (record) => writeFile(join(layoutRoot, "data-layout.json"), `${JSON.stringify(record)}\n`);
    const journal = (version) => writeFile(journalFile, `${JSON.stringify({ format: "zelavis-runtime/1", generation: 3, selected: { version, digest: older.selected.digest } })}\n`);
    const declare = async (version, dataFormat) => {
      const file = join(directory, version, "runtime-artifact.json");
      const artifact = JSON.parse(await readFile(file, "utf8"));
      if (dataFormat === undefined) delete artifact.metadata.dataFormat; else artifact.metadata.dataFormat = dataFormat;
      await writeFile(file, `${JSON.stringify(artifact)}\n`);
    };

    assert.deepEqual(await select(), { version: ZELAVIS_VERSION }, "a host that never ran starts on the Platform's engine");
    await journal(ZELAVIS_VERSION);
    assert.deepEqual(await select(), { version: ZELAVIS_VERSION });

    await journal("1.0.0");
    await declare("1.0.0", undefined);
    const held = await select();
    assert.equal(held.version, "1.0.0", "format 2 data stays on the engine that wrote it, not the Platform's");
    assert.match(held.heldReason, /format 2.*older.*recipe is upgraded/);

    const { CURRENT_FORMAT } = await import("../dist/db/kv-store.js");
    await declare("1.0.0", CURRENT_FORMAT);
    assert.deepEqual(await select(), { version: ZELAVIS_VERSION }, "equal formats keep following the Platform");

    // A migration records the layout it left: the data now agrees with the Platform even though the host's engine declares format 2.
    await declare("1.0.0", undefined);
    await layout({ format: CURRENT_FORMAT });
    assert.deepEqual(await select(), { version: ZELAVIS_VERSION }, "migrated data follows the Platform");
    // An undone migration puts the old layout back and names the engine that wrote it, even if the journal already names the Platform's.
    await journal(ZELAVIS_VERSION);
    await layout({ format: 2, engine: "1.0.0" });
    const undone = await select();
    assert.equal(undone.version, "1.0.0", "old data stays on the engine that wrote it");
    await rm(join(directory, "data-layout.json"), { force: true });

    await journal("1.0.0");
    await rm(join(directory, "1.0.0"), { recursive: true, force: true });
    await assert.rejects(select(), undefined, "a held Project whose engine was removed fails loudly instead of opening its data on another engine");

    await writeFile(journalFile, "not a journal");
    await assert.rejects(select());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("one operation hashes a release once, and no later operation or catalog inherits that verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-operation-"));
  try {
    const value = await release(directory, "1.0.0");
    const remembered = new Map();
    const operation = createNodeRuntimeCatalog({ directory, rootOwned: false }, remembered);
    const selected = await Effect.runPromise(operation.select("1.0.0"));
    assert.equal(remembered.size, 1);
    // A byte changed after the operation verified the release is not read again by that operation (it was hashed once)...
    await writeFile(join(value.root, "platform/dist/adapters/_node-project-engine.js"), "modified engine");
    const execution = await Effect.runPromise(operation.resolve(selected, "project", {}, {}));
    assert.equal(execution.cwd, value.root);
    assert.equal(remembered.size, 1, "naming the same release again adds no second verification");
    // ...but a catalog with no memory, or the next operation's own memory, verifies every byte afresh and refuses it.
    await assert.rejects(Effect.runPromise(createNodeRuntimeCatalog({ directory, rootOwned: false }).resolve(selected, "project", {}, {})), /file digest mismatch/);
    await assert.rejects(Effect.runPromise(createNodeRuntimeCatalog({ directory, rootOwned: false }, new Map()).select("1.0.0")), /file digest mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a file hashed once is not read again unchanged, but any change to it, even one that keeps its size and modification time, is hashed again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-fingerprint-"));
  try {
    const value = await release(directory, "1.0.0");
    const file = join(value.root, "platform/dist/adapters/_node-project-engine.js");
    await Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected));
    await Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected));
    // Same length, same modification time restored: only ctime (which a program cannot set back) differs.
    const before = await stat(file), original = await readFile(file, "utf8");
    await writeFile(file, original.replace(/./, "X"));
    await utimes(file, before.atime, before.mtime);
    assert.equal((await stat(file)).size, before.size);
    await assert.rejects(Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected)), /file digest mismatch/);
    // Restoring the original bytes verifies again, and the refusal was never remembered as good.
    await writeFile(file, original);
    await Effect.runPromise(verifyNodeRuntimeArtifact(value.root, value.selected));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a file larger than one whole read is streamed, and its digest is held to the same manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-engine-large-file-"));
  try {
    const value = await release(directory, "1.0.0");
    // 9 MiB: over the size a file is read whole at, so verification streams it, while sealing always streams.
    const big = join(value.root, "platform/dist/large.bin");
    const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
    await writeFile(big, bytes);
    const artifact = await Effect.runPromise(sealNodeRuntimeArtifact(value.root));
    const selected = { version: "1.0.0", digest: artifact.digest };
    await Effect.runPromise(verifyNodeRuntimeArtifact(value.root, selected));
    bytes[5 * 1024 * 1024] = 8;
    await writeFile(big, bytes);
    await assert.rejects(Effect.runPromise(verifyNodeRuntimeArtifact(value.root, selected)), /file digest mismatch: platform\/dist\/large\.bin/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
