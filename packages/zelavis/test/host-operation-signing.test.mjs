import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
import { verifySignedHostOperationManifest } from "../dist/core/deployment/index.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const manifest = (overrides = {}) => ({
  id: "native.preflight",
  version: "v1",
  sha256: sha("#!/bin/sh\nprintf ok\n"),
  interpreter: "/bin/sh",
  arguments: {},
  ...overrides,
});

test("a manifest verifies only unaltered, under a trusted unrevoked key inside its window", async () => {
  const release = await createReleaseSigner();
  const signed = await release.sign(manifest());
  assert.deepEqual(await verifySignedHostOperationManifest(signed, release.trust), manifest());

  for (const altered of [
    { ...signed, manifest: { ...signed.manifest, sha256: "b".repeat(64) } },
    { ...signed, manifest: { ...signed.manifest, interpreter: "/bin/bash" } },
    { ...signed, manifest: { ...signed.manifest, arguments: { extra: {} } } },
    { ...signed, signedAt: new Date(Date.parse(signed.signedAt) - 1).toISOString() },
    { ...signed, signature: Buffer.alloc(64).toString("base64") },
    { ...signed, signature: "not base64!" },
  ]) {
    await assert.rejects(verifySignedHostOperationManifest(altered, release.trust), /signature is invalid|Invalid base64/);
  }

  const stranger = await createReleaseSigner();
  await assert.rejects(verifySignedHostOperationManifest(signed, stranger.trust), /signature is invalid/);
  const otherKeyId = await createReleaseSigner({ keyId: "someone-else" });
  await assert.rejects(verifySignedHostOperationManifest(signed, otherKeyId.trust), /untrusted key "test-release-2026"/);
  await assert.rejects(
    verifySignedHostOperationManifest(signed, { ...release.trust, revokedKeyIds: ["test-release-2026"] }),
    /revoked key/,
  );
  // Ambiguous trust (the same key id twice) is refused, not resolved.
  await assert.rejects(
    verifySignedHostOperationManifest(signed, { keys: [release.key, release.key] }),
    /untrusted key/,
  );
  await assert.rejects(release.sign(manifest({ unexpected: true })), /unknown fields/);
  await assert.rejects(
    verifySignedHostOperationManifest({ ...signed, manifest: { ...signed.manifest, unexpected: true } }, release.trust),
    /unknown fields/,
  );
  await assert.rejects(release.sign(manifest({ interpreter: "bin/sh" })), /absolute path/);
});

test("rotation: a closed key window keeps old releases valid and refuses new or future signatures", async () => {
  const now = Date.now();
  const old = await createReleaseSigner({
    keyId: "release-2025",
    notBefore: new Date(now - 400 * 86_400_000).toISOString(),
    notAfter: new Date(now - 30 * 86_400_000).toISOString(),
  });
  const inside = await old.sign(manifest(), { signedAt: new Date(now - 60 * 86_400_000).toISOString() });
  assert.equal((await verifySignedHostOperationManifest(inside, old.trust)).id, "native.preflight");
  const after = await old.sign(manifest(), { signedAt: new Date(now - 86_400_000).toISOString() });
  await assert.rejects(verifySignedHostOperationManifest(after, old.trust), /validity window/);

  const current = await createReleaseSigner({ keyId: "release-2026" });
  const future = await current.sign(manifest(), { signedAt: new Date(now + 3_600_000).toISOString() });
  await assert.rejects(verifySignedHostOperationManifest(future, current.trust), /validity window/);
  // Both keys trusted at once during the overlap.
  const both = { keys: [old.key, current.key] };
  assert.ok(await verifySignedHostOperationManifest(inside, both));
  assert.ok(await verifySignedHostOperationManifest(await current.sign(manifest()), both));
});

async function operationRoot(t) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-signed-ops-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  await mkdir(root, { mode: 0o700 });
  return { directory, root };
}

// For tests that stage an interpreter and need its identity proof to pass:
// see the comment on localScratchRoot above.
async function localOperationRoot(t) {
  await mkdir(localScratchRoot, { recursive: true, mode: 0o755 });
  const directory = await mkdtemp(join(localScratchRoot, "signed-ops-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "operations");
  await mkdir(root, { mode: 0o700 });
  return { directory, root };
}

test("the executor refuses unsigned, untrusted and shebang-without-interpreter operations", async (t) => {
  const release = await createReleaseSigner();
  const { root } = await operationRoot(t);
  const body = "#!/bin/sh\nprintf ok\n";
  await writeFile(join(root, "op"), body, { mode: 0o700 });
  const options = (operations, trust = release.trust) => ({
    rootDirectory: root, trust, operations, authorize: async () => true,
  });

  await assert.rejects(
    createNodeHostOperationExecutor(options([{ file: "op", signed: { manifest: manifest() } }])),
    /invalid key id/,
  );
  const stranger = await createReleaseSigner({ keyId: "stranger" });
  await assert.rejects(
    createNodeHostOperationExecutor(options([{ file: "op", signed: await stranger.sign(manifest()) }])),
    /untrusted key "stranger"/,
  );
  const { interpreter: _interpreter, ...native } = manifest();
  await assert.rejects(
    createNodeHostOperationExecutor(options([{ file: "op", signed: await release.sign(native) }])),
    /must declare an interpreter/,
  );
});

test("the interpreter is part of the proven identity and re-proven before every run", async (t) => {
  const release = await createReleaseSigner();
  const { directory, root } = await localOperationRoot(t);
  const tools = join(directory, "tools");
  await mkdir(tools, { mode: 0o755 });
  // A working interpreter in a directory the test controls. Copies of signed
  // system binaries are killed on macOS, so hard-link Node where possible.
  const interpreter = join(tools, "node");
  // Hard-link where possible: a copy of a signed system Node binary is
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
  const signed = await release.sign(manifest({ sha256: sha(body), interpreter }));
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root, trust: release.trust, authorize: async () => true,
    stagingDirectory: directory,
    operations: [{ file: "op", signed }],
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
      rootDirectory: root, trust: release.trust, authorize: async () => true,
      stagingDirectory: directory, operations: [{ file: "op", signed }],
    }),
    /not an immutable executable path/,
  );
  await chmod(tools, 0o755);
});

test("installed operations load from <root>/<id>/<version> and must match their manifest", async (t) => {
  const release = await createReleaseSigner();
  const { directory, root } = await operationRoot(t);
  const body = "printf installed\n";
  const version = join(root, "native.preflight", "v1");
  await mkdir(version, { recursive: true, mode: 0o700 });
  await writeFile(join(version, "artifact"), body, { mode: 0o700 });
  await writeFile(join(version, "manifest.json"), JSON.stringify(await release.sign(manifest({ sha256: sha(body) }))));

  const operations = await loadInstalledHostOperations(root);
  assert.deepEqual(operations.map((operation) => operation.file), [join("native.preflight", "v1", "artifact")]);
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: root, trust: release.trust, authorize: async () => true, stagingDirectory: directory, operations,
  });
  const result = await executor.execute({
    operationId: "operation_installed_000001", operation: "native.preflight", version: "v1",
    artifactDigest: sha(body), authority: "x", arguments: {}, deadline: new Date(Date.now() + 10_000).toISOString(),
  });
  assert.equal(result.stdout, "installed");

  const misplaced = join(root, "native.other", "v1");
  await mkdir(misplaced, { recursive: true, mode: 0o700 });
  await writeFile(join(misplaced, "manifest.json"), JSON.stringify(await release.sign(manifest({ sha256: sha(body) }))));
  await assert.rejects(loadInstalledHostOperations(root), /does not match its manifest identity/);
});
