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

test("the Agent unit delegates cgroups and runs signed operations from the release tree", async () => {
  const unit = await readFile(new URL("runtime/zelavis-agent.service", distribution), "utf8");
  assert.match(unit, /^Delegate=yes$/m);
  assert.match(unit, /^User=zelavis$/m);
  for (const flag of [
    "--operations-root /opt/zelavis/current/operations",
    "--operation-trust /etc/zelavis/operation-trust.json",
    "--platform-authority /var/lib/zelavis/system/agent-authority/platform-authority.json",
    "--require-root-owned-operations",
    "--operation-cgroup delegated",
  ]) {
    assert.ok(unit.includes(flag), flag);
  }
  const deb = await readFile(new URL("scripts/build-deb.mjs", distribution), "utf8");
  assert.match(deb, /conffiles.*operation-trust\.json/s);
  // Installed but never enabled by the package.
  assert.doesNotMatch(deb, /systemctl enable zelavis-agent/);
});

test("release trust store is a valid, key-unique structure", async () => {
  const release = JSON.parse(await readFile(new URL("release.json", distribution), "utf8"));
  const trust = release.operationTrust;
  assert.ok(Array.isArray(trust.keys));
  assert.ok(Array.isArray(trust.revokedKeyIds));
  assert.equal(new Set(trust.keys.map((key) => key.keyId)).size, trust.keys.length);
  for (const key of trust.keys) {
    assert.equal(Buffer.from(key.publicKey, "base64").byteLength, 32);
    assert.ok(Date.parse(key.notBefore) < Date.parse(key.notAfter));
  }
});

const builtRuntime = await import("node:fs").then(({ existsSync }) =>
  existsSync(new URL("../packages/zelavis/dist/core/deployment/index.js", distribution)));

test("release signing produces operations the release trust store accepts, and nothing else", {
  skip: !builtRuntime && "build packages/zelavis first (pnpm --filter zelavis build)",
}, async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { generateOperationSigningKey, stageSignedOperations } = await import("../scripts/operation-signing.mjs");
  const { verifySignedHostOperationManifest } = await import("../../packages/zelavis/dist/core/deployment/index.js");
  const directory = await mkdtemp(join(tmpdir(), "zelavis-release-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const operation = join(source, "native.preflight", "v1");
  await mkdir(operation, { recursive: true });
  await writeFile(join(operation, "artifact"), "printf ok\n", { mode: 0o755 });
  await writeFile(join(operation, "operation.json"), JSON.stringify({
    id: "native.preflight", version: "v1", interpreter: "/bin/sh", arguments: {},
  }));

  const release = await generateOperationSigningKey({ keyId: "release-test", notBefore: new Date(Date.now() - 60_000) });
  const trust = { keys: [release.trustEntry], revokedKeyIds: [] };
  const output = join(directory, "operations");
  const staged = await stageSignedOperations({
    source, output, trust, signingKey: release.privateKeyPkcs8, keyId: "release-test",
  });
  assert.deepEqual(staged.signed, ["native.preflight@v1"]);
  const envelope = JSON.parse(await (await import("node:fs/promises")).readFile(join(output, "native.preflight", "v1", "manifest.json"), "utf8"));
  assert.equal((await verifySignedHostOperationManifest(envelope, trust)).sha256.length, 64);

  // A key the release trust store does not list fails the build.
  const stray = await generateOperationSigningKey({ keyId: "stray", notBefore: new Date(Date.now() - 60_000) });
  await assert.rejects(
    stageSignedOperations({ source, output: join(directory, "stray"), trust, signingKey: stray.privateKeyPkcs8, keyId: "stray" }),
    /untrusted key/,
  );
  // No release keys published yet: omitted, not a build failure.
  const unkeyed = await stageSignedOperations({ source, output: join(directory, "unkeyed"), trust: { keys: [] } });
  assert.equal(unkeyed.skipped, true);
  assert.match(unkeyed.reason, /lists no keys/);
  // Keys published but no signing key: fail, or omit when explicitly allowed —
  // never ship unsigned.
  await assert.rejects(stageSignedOperations({ source, output: join(directory, "nokey"), trust }), /need signing/);
  const skipped = await stageSignedOperations({ source, output: join(directory, "skip"), trust, allowSkip: true });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(await readdir(join(directory, "skip")), []);
  // A template that claims a digest is refused.
  await writeFile(join(operation, "operation.json"), JSON.stringify({ id: "native.preflight", version: "v1", sha256: "a".repeat(64), arguments: {} }));
  await assert.rejects(
    stageSignedOperations({ source, output: join(directory, "bad"), trust, signingKey: release.privateKeyPkcs8, keyId: "release-test" }),
    /omit sha256/,
  );
});

test("shipped host operation sources are valid, signable and produce their declared result", {
  skip: !builtRuntime && "build packages/zelavis first (pnpm --filter zelavis build)",
}, async (t) => {
  const { mkdtemp, readdir, readFile: read, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { generateOperationSigningKey, stageSignedOperations } = await import("../scripts/operation-signing.mjs");
  const { validateHostOperationManifest, MAX_HOST_OPERATION_RESULT_BYTES } = await import("../../packages/zelavis/dist/core/deployment/index.js");
  const source = new URL("operations/", distribution).pathname;
  const ids = (await readdir(source, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(ids.length >= 1);
  for (const id of ids) {
    for (const version of (await readdir(join(source, id.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const directory = join(source, id.name, version.name);
      const template = JSON.parse(await read(join(directory, "operation.json"), "utf8"));
      // Every shipped operation declares who may request it.
      assert.ok(template.authorization, `${id.name} declares authorization`);
      validateHostOperationManifest({ ...template, sha256: "a".repeat(64) });
      if (template.interpreter === "/bin/sh") execFileSync("sh", ["-n", join(directory, "artifact")]);
      if (template.result) {
        const output = execFileSync(template.interpreter ?? join(directory, "artifact"),
          template.interpreter ? [join(directory, "artifact")] : [], { encoding: "utf8" }).trim();
        assert.ok(Buffer.byteLength(output) <= template.result.maxBytes);
        assert.ok(template.result.maxBytes <= MAX_HOST_OPERATION_RESULT_BYTES);
        const value = JSON.parse(output);
        assert.equal(typeof value, "object");
      }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "zelavis-shipped-operations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await generateOperationSigningKey({ keyId: "shipped-test", notBefore: new Date(Date.now() - 60_000) });
  const staged = await stageSignedOperations({
    source, output: directory, trust: { keys: [release.trustEntry] },
    signingKey: release.privateKeyPkcs8, keyId: "shipped-test",
  });
  assert.ok(staged.signed.includes("zelavis.host-report@v1"));
});
