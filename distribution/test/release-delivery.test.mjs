import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { writeChecksums } from "../scripts/checksums.mjs";
import { buildPublicDelivery, collectReleaseArtifacts, releaseTargets } from "../scripts/release-delivery.mjs";
import { releaseContext } from "../scripts/release-context.mjs";
import { stagePublishedPackage } from "../scripts/published-package.mjs";

const version = "2.0.0-alpha.6";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "targets");
  for (const target of releaseTargets) {
    const directory = join(input, `zelavis-${target}`);
    await mkdir(directory, { recursive: true });
    for (const extension of ["tar.gz", "zip"]) await writeFile(join(directory, `zelavis-${version}-${target}.${extension}`), target + extension);
    if (target.startsWith("linux")) await writeFile(join(directory, `zelavis_2.0.0~alpha.6_${target.endsWith("x64") ? "amd64" : "arm64"}.deb`), target + "deb");
    await writeChecksums(directory);
  }
  return { root, input, output: join(root, "artifacts") };
}

test("one release contains every target, one checksum manifest, and separate alpha aliases", async (t) => {
  const { root, input, output } = await fixture(t);
  assert.equal((await collectReleaseArtifacts(input, output, version)).length, 10);
  assert.equal((await readFile(join(output, "SHA256SUMS"), "utf8")).trim().split("\n").length, 10);
  const delivery = join(root, "public");
  assert.equal(await buildPublicDelivery(output, delivery, version), "alpha");
  assert.equal(await readFile(join(delivery, "downloads", "alpha", "version"), "utf8"), version + "\n");
  assert.deepEqual((await readdir(join(delivery, "downloads"))).sort(), ["alpha", "releases"]);
  const archive = `zelavis-${version}-linux-x64.tar.gz`;
  assert.equal(await readFile(join(delivery, "downloads", "alpha", "zelavis-linux-x64.tar.gz"), "utf8"), await readFile(join(output, archive), "utf8"));
  assert.match(await readFile(join(delivery, "downloads", "alpha", "zelavis-linux-x64.tar.gz.sha256"), "utf8"), /^[0-9a-f]{64}\n$/);
  const installer = await readFile(join(delivery, "site", "install.sh"), "utf8");
  assert.doesNotMatch(installer, /@ZELAVIS_VERIFIED_BOOTSTRAP@/);
  assert.equal(spawnSync("sh", ["-n"], { input: installer }).status, 0);
});

test("missing targets, checksum changes, duplicate checksums, stale versions and overlapping outputs fail before publication", async (t) => {
  const { input, output } = await fixture(t);
  const target = join(input, "zelavis-linux-x64");
  const sum = await readFile(join(target, "SHA256SUMS"), "utf8");
  await writeFile(join(target, "SHA256SUMS"), sum + sum.split("\n")[0] + "\n");
  await assert.rejects(collectReleaseArtifacts(input, output, version), /Invalid checksum/);
  await writeFile(join(target, "SHA256SUMS"), sum);
  await writeFile(join(target, `zelavis-${version}-linux-x64.zip`), "corrupted");
  await assert.rejects(collectReleaseArtifacts(input, output, version), /checksum mismatch/);
  await assert.rejects(collectReleaseArtifacts(input, output, "2.0.0-alpha.7"), /Incomplete or unexpected/);
  await assert.rejects(collectReleaseArtifacts(input, join(input, "nested", "output"), version), /separate/);
  await assert.rejects(readFile(join(output, "SHA256SUMS")), { code: "ENOENT" });
  await rm(join(input, "zelavis-darwin-arm64"), { recursive: true });
  await writeChecksums(target);
  await assert.rejects(collectReleaseArtifacts(input, output, version), { code: "ENOENT" });
});

test("tags match package identity and require owner keys; alpha never becomes GitHub latest", () => {
  const secrets = { OPERATION_KEY: "test", OPERATION_KEY_ID: "test", APT_KEY: "test", APT_KEY_ID: "test" };
  assert.deepEqual(releaseContext(`refs/tags/zelavis@${version}`, version, secrets), { version, tagged: true, prerelease: true });
  assert.equal(releaseContext("refs/tags/zelavis@2.0.0", "2.0.0", secrets).prerelease, false);
  assert.throws(() => releaseContext(`refs/tags/zelavis@${version}`, version), /not configured/);
  assert.throws(() => releaseContext("refs/tags/v2.0.0", version, secrets), /must match/);
  assert.throws(() => releaseContext("refs/heads/dev", "latest"), /Invalid Platform/);
  assert.equal(releaseContext("refs/heads/dev", version).tagged, false);
});

test("published staging retains hoisted dependencies, package self resolution and executable links after relocation", async (t) => {
  const { root } = await fixture(t);
  const output = join(root, "stage");
  await stagePublishedPackage(output, version, (node, args) => {
    assert.equal(node, join(output, "runtime/node/bin/node"));
    assert.ok(args.includes(`zelavis@${version}`));
    assert.ok(args.includes("--omit=dev"));
    const modules = join(output, ".npm-project/node_modules");
    mkdirSync(join(modules, "zelavis/dist"), { recursive: true });
    mkdirSync(join(modules, "dependency"));
    mkdirSync(join(modules, ".bin"));
    writeFileSync(join(modules, "zelavis/package.json"), JSON.stringify({ name: "zelavis", version, type: "module", exports: "./dist/index.js" }));
    writeFileSync(join(modules, "zelavis/dist/index.js"), 'import dependency from "dependency"; export default dependency;');
    writeFileSync(join(modules, "dependency/package.json"), JSON.stringify({ name: "dependency", type: "module", exports: "./index.js" }));
    writeFileSync(join(modules, "dependency/index.js"), 'export default "retained";');
    symlinkSync("../zelavis/dist/index.js", join(modules, ".bin/zelavis"));
  });
  assert.equal((await import(pathToFileURL(join(output, "platform/node_modules/.bin/zelavis")))).default, "retained");
  assert.equal((await import(pathToFileURL(join(output, "platform/node_modules/zelavis/dist/index.js")))).default, "retained");
  await assert.rejects(readdir(join(output, ".npm-project")), { code: "ENOENT" });
});

const script = await readFile(new URL("../installers/install.sh", import.meta.url), "utf8");

test("public bootstrap resolves once, verifies exact assets and forwards user/named flags literally", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-public-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, `zelavis-${version}-linux-x64`);
  await mkdir(join(tree, "runtime/node/bin"), { recursive: true });
  await mkdir(join(tree, "platform/dist"), { recursive: true });
  await writeFile(join(tree, "runtime/node/bin/node"), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(tree, "manifest.json"), JSON.stringify({ name: "zelavis", version, platform: "linux", architecture: "x64" }));
  await writeFile(join(tree, "platform/dist/cli.js"), 'require("node:fs").writeFileSync(process.env.TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));');
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "zelavis", version, dist: { integrity: "sha512-YWJjZA==" } }));
  const archive = `zelavis-${version}-linux-x64.tar.gz`;
  const packed = spawnSync("tar", ["-czf", join(root, archive), "-C", root, `zelavis-${version}-linux-x64`]);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  await writeChecksums(root);
  const harness = `
    uname() { case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac; }
    id() { echo 0; }
    mktemp() { command mktemp -d "$TEST_ROOT/download.XXXXXX"; }
    curl() {
      printf '%s\\n' "$*" >> "$TEST_ROOT/requests";
      case "$*" in *dist-tags*) printf '%s' '{"alpha":"${version}","latest":"1.0.0"}'; return ;; esac
      case "$*" in */zelavis/${version}*) FILE=package.json ;; *SHA256SUMS*) FILE=SHA256SUMS ;; *${archive}*) FILE=${archive} ;; *) return 91 ;; esac
      while [ "$1" != -o ]; do shift; done; shift
      cp "$TEST_ROOT/$FILE" "$1"
    }
  `;
  const execute = (args) => spawnSync("/bin/sh", ["-c", harness + script, "--", ...args], { encoding: "utf8", env: { ...process.env, TEST_ROOT: root, TEST_OUTPUT: join(root, "argv.json"), NODE_OPTIONS: "--require=/no-such-injection" } });
  const installed = execute(["--channel", "alpha", "--user", "--dry-run", "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  const argv = JSON.parse(await readFile(join(root, "argv.json"), "utf8"));
  assert.equal(argv[0], "install");
  assert.deepEqual(argv.slice(3, 10), ["--source", "release", "--installed-by", "archive", "--user", "--dry-run", "--json"]);
  assert.match(await readFile(join(root, "requests"), "utf8"), new RegExp(`releases/download/zelavis@${version}`));
  await rm(join(root, "argv.json"));
  const named = execute(["--version", version, "--instance", "preview", "--port", "3100"]);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, "argv.json"), "utf8")).slice(7, 11), ["--instance", "preview", "--port", "3100"]);
  const created = execute([version, "--user"]);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, "argv.json"), "utf8")).slice(3, 7), ["--source", "package", "--installed-by", "create"]);
  await rm(join(root, "argv.json"));
  const sums = await readFile(join(root, "SHA256SUMS"), "utf8");
  await writeFile(join(root, "SHA256SUMS"), sums.replace(/^[0-9a-f]{64}/, "0".repeat(64)));
  const refused = execute(["--version", version, "--instance", "preview", "--port", "3100"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /checksum verification failed/);
  await assert.rejects(readFile(join(root, "argv.json")), { code: "ENOENT" });
  assert.equal((await readdir(root)).some((name) => name.startsWith("download.")), false);
  const invalid = execute(["--version", "../../escape", "--user"]);
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /exact Zelavis version/);
  assert.equal(execute(["--help"]).status, 0);
});
