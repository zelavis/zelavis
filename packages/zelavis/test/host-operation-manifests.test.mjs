import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// System temp directories (e.g. `/tmp`, mode 1777 on Linux/macOS) are
// deliberately world-writable, which the interpreter-identity proof below
// rejects on every ancestor of the interpreter path -- so a test interpreter
// staged under `tmpdir()` fails that check before the test's own assertions
// even run. Stage it under the checkout instead, whose ancestors carry no
// group/other write bit.
const localScratchRoot = join(import.meta.dirname, ".tmp");

import {
  createNodeHostOperationExecutor,
  loadInstalledHostOperations,
} from "../dist/adapters/_node-host-operation-executor.js";
import { validateHostOperationManifest } from "../dist/core/deployment/index.js";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const manifest = (overrides = {}) => ({
  id: "native.preflight",
  version: "v1",
  sha256: sha("#!/bin/sh\nprintf ok\n"),
  interpreter: "/bin/sh",
  arguments: {},
  ...overrides,
});

test("a manifest is validated strictly: unknown fields and relative interpreters are refused", () => {
  assert.deepEqual(validateHostOperationManifest(manifest()), manifest());
  assert.throws(() => validateHostOperationManifest(manifest({ unexpected: true })), /unknown fields/);
  assert.throws(() => validateHostOperationManifest(manifest({ interpreter: "bin/sh" })), /absolute path/);
  assert.throws(() => validateHostOperationManifest(manifest({ sha256: "nope" })), /sha256|digest/i);
});

async function operationRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-host-ops-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  await mkdir(root, { mode: 0o700 });
  return { directory, root };
}

// For tests that stage an interpreter and need its identity proof to pass:
// see the comment on localScratchRoot above.
async function localOperationRoot(t) {
  await mkdir(localScratchRoot, { recursive: true, mode: 0o755 });
  const directory = await mkdtemp(join(localScratchRoot, "host-ops-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  await mkdir(root, { mode: 0o700 });
  return { directory, root };
}

test("the executor refuses an invalid manifest and a shebang script without an interpreter", async (t) => {
  const { root } = await operationRoot(t);
  const body = "#!/bin/sh\nprintf ok\n";
  await writeFile(join(root, "op"), body, { mode: 0o700 });
  const options = (operations) => ({ rootDirectory: root, operations, authorize: async () => true });

  await assert.rejects(
    createNodeHostOperationExecutor(options([{ file: "op", manifest: manifest({ unexpected: true }) }])),
    /unknown fields/,
  );
  const { interpreter: _interpreter, ...native } = manifest();
  await assert.rejects(
    createNodeHostOperationExecutor(options([{ file: "op", manifest: native }])),
    /must declare an interpreter/,
  );
});

test("the interpreter is part of the proven identity and re-proven before every run", async (t) => {
  const { directory, root } = await localOperationRoot(t);
  const tools = join(directory, "tools");
  await mkdir(tools, { mode: 0o755 });
  // A working interpreter in a directory the test controls. Copies of system
  // binaries are killed on macOS, so hard-link Node where possible.
  const interpreter = join(tools, "node");
  // Hard-link where possible: a copy of a system Node binary is
  // rejected by macOS Gatekeeper the moment it's touched from a new path.
  // Never chmod a hard link in place, though -- it shares the real binary's
  // inode, so a chmod would mutate that binary everywhere else it's used.
  // If linking succeeds but leaves the interpreter group/other-writable (as
  // GitHub's hosted Node toolcache installs it, worryingly, 0o777), the
  // source itself fails this test's own safety bar and must not be trusted
  // or modified in place, so fall back to an independent copy instead.
  let linked = await link(process.execPath, interpreter).then(() => true, () => false);
  if (linked && ((await lstat(interpreter)).mode & 0o022) !== 0) {
    await rm(interpreter, { force: true });
    linked = false;
  }
  if (!linked) {
    await copyFile(process.execPath, interpreter, fsConstants.COPYFILE_FICLONE);
    await chmod(interpreter, 0o755);
  }
  const body = "process.stdout.write(\"interpreted\")\n";
  await writeFile(join(root, "op"), body, { mode: 0o700 });
  const installed = manifest({ sha256: sha(body), interpreter });
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root, authorize: async () => true,
    stagingDirectory: directory,
    operations: [{ file: "op", manifest: installed }],
  });
  const request = (operationId) => ({
    operationId, operation: "native.preflight", version: "v1", artifactDigest: sha(body),
    authority: "x", arguments: {}, deadline: new Date(Date.now() + 10_000).toISOString(),
  });
  const first = await executor.execute(request("operation_interpreter_0001"));
  assert.equal(first.stdout, "interpreted", JSON.stringify(first));

  // Replaced by an identical copy: a new inode, so refused.
  await copyFile(process.execPath, `${interpreter}.new`, fsConstants.COPYFILE_FICLONE);
  await chmod(`${interpreter}.new`, 0o755);
  await rename(`${interpreter}.new`, interpreter);
  await assert.rejects(executor.execute(request("operation_interpreter_0002")), /interpreter changed after registration/);

  // A writable interpreter directory is refused at registration.
  await chmod(tools, 0o777);
  await assert.rejects(
    createNodeHostOperationExecutor({
      rootDirectory: root, authorize: async () => true,
      stagingDirectory: directory, operations: [{ file: "op", manifest: installed }],
    }),
    /not an immutable executable path/,
  );
  await chmod(tools, 0o755);
});

test("installed operations load from <root>/<id>/<version> and must match their manifest", async (t) => {
  const { directory, root } = await operationRoot(t);
  const body = "printf installed\n";
  const version = join(root, "native.preflight", "v1");
  await mkdir(version, { recursive: true, mode: 0o700 });
  await writeFile(join(version, "artifact"), body, { mode: 0o700 });
  await writeFile(join(version, "manifest.json"), JSON.stringify(manifest({ sha256: sha(body) })));

  const operations = await loadInstalledHostOperations(root);
  assert.deepEqual(operations.map((operation) => operation.file), [join("native.preflight", "v1", "artifact")]);
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root, authorize: async () => true, stagingDirectory: directory, operations,
  });
  const result = await executor.execute({
    operationId: "operation_installed_000001", operation: "native.preflight", version: "v1",
    artifactDigest: sha(body), authority: "x", arguments: {}, deadline: new Date(Date.now() + 10_000).toISOString(),
  });
  assert.equal(result.stdout, "installed");

  const misplaced = join(root, "native.other", "v1");
  await mkdir(misplaced, { recursive: true, mode: 0o700 });
  await writeFile(join(misplaced, "manifest.json"), JSON.stringify(manifest({ sha256: sha(body) })));
  await assert.rejects(loadInstalledHostOperations(root), /does not match its manifest identity/);
});

test("an installed manifest must be a regular file only its owner can change", async (t) => {
  const { root } = await operationRoot(t);
  const body = "printf installed\n";
  const version = join(root, "native.preflight", "v1");
  await mkdir(version, { recursive: true, mode: 0o700 });
  await writeFile(join(version, "artifact"), body, { mode: 0o700 });
  const file = join(version, "manifest.json");
  await writeFile(file, JSON.stringify(manifest({ sha256: sha(body) })), { mode: 0o644 });
  assert.equal((await loadInstalledHostOperations(root)).length, 1);

  await chmod(file, 0o666);
  await assert.rejects(loadInstalledHostOperations(root), /regular file that is not group- or world-writable/);
  await chmod(file, 0o644);

  await rm(file);
  await symlink(join(root, "elsewhere.json"), file);
  await assert.rejects(loadInstalledHostOperations(root), /regular file that is not group- or world-writable/);

  if (process.getuid?.() !== 0) {
    await rm(file, { force: true });
    await writeFile(file, JSON.stringify(manifest({ sha256: sha(body) })), { mode: 0o644 });
    await assert.rejects(loadInstalledHostOperations(root, { requireRootOwned: true }), /regular root-owned file/);
  }
});
