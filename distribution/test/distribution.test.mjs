import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const distribution = new URL("../", import.meta.url);

test("release configuration pins a supported Node runtime", async () => {
  const release = JSON.parse(await readFile(new URL("release.json", distribution), "utf8"));
  assert.match(release.nodeVersion, /^24\./);
  assert.equal(release.minimumNodeMajor, 24);
  assert.equal(release.operationTrust, undefined, "releases are not signed; there is no trust store");
});

test("release configuration pins a supported Traefik runtime", async () => {
  const release = JSON.parse(await readFile(new URL("release.json", distribution), "utf8"));
  assert.match(release.traefikVersion, /^3\./);
});

test("the Traefik unit uses bounded capabilities and restricts filesystem access", async () => {
  const unit = await readFile(new URL("runtime/zelavis-traefik.service", distribution), "utf8");
  assert.match(unit, /^AmbientCapabilities=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^CapabilityBoundingSet=CAP_NET_BIND_SERVICE$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^User=zelavis$/m);
  assert.match(unit, /^Group=zelavis$/m);
  assert.match(unit, /ReadWritePaths=\/var\/lib\/zelavis\/edge\/traefik/);
  assert.match(unit, /ExecStart=\/opt\/zelavis\/current\/edge\/traefik\/traefik --configFile=\/etc\/zelavis\/edge\/traefik\/traefik\.yml/);
});

test("traefik static configuration watches active directory and disables dashboard", async () => {
  const config = await readFile(new URL("runtime/traefik.yml", distribution), "utf8");
  assert.match(config, /dashboard:\s*false/);
  assert.match(config, /insecure:\s*false/);
  assert.match(config, /directory:\s*\/var\/lib\/zelavis\/edge\/traefik\/active/);
  assert.match(config, /watch:\s*true/);
  assert.match(config, /address:\s*":80"/);
  assert.match(config, /address:\s*":443"/);
});

test("the Debian package manages Traefik unit, conffiles, and enables production ingress by default", async () => {
  const builder = await readFile(new URL("scripts/build-deb.mjs", distribution), "utf8");
  assert.match(builder, /zelavis-traefik\.service/);
  assert.match(builder, /\/etc\/zelavis\/edge\/traefik\/traefik\.yml/);
  assert.match(builder, /conffiles.*\/etc\/zelavis\/edge\/traefik\/traefik\.yml/s);
  assert.match(builder, /cli\.js install --from-release/);
  const plan = await readFile(new URL("../../packages/zelavis/src/core/runtime/installation-plan.ts", import.meta.url), "utf8");
  assert.match(plan, /\["enable", "zelavis-traefik\.service"\]/);
  assert.match(builder, /systemctl stop zelavis\.service zelavis-traefik\.service/);
});

test("the bootstrap acquires only Node and the npm package, and trusts nothing else", async () => {
  const release = JSON.parse(await readFile(new URL("release.json", distribution), "utf8"));
  const installer = await readFile(new URL("installers/install.sh", distribution), "utf8");
  assert.match(installer, new RegExp(`^NODE_VERSION=${release.nodeVersion.replaceAll(".", "\\.")}$`, "m"), "install.sh pins the release's Node");
  assert.match(installer, /https:\/\/nodejs\.org\/dist\/v\$1\/SHASUMS256\.txt/);
  assert.match(installer, /Node checksum verification failed/);
  assert.match(installer, /registry=https:\/\/registry\.npmjs\.org/);
  assert.match(installer, /--omit=dev --ignore-scripts/, "dependency install scripts never run, possibly as root");
  assert.doesNotMatch(installer, /rebuild|node-gyp|build-essential/, "no native build: every dependency is plain JavaScript");
  assert.match(installer, /install --from-npm "\$TREE"/);
  assert.doesNotMatch(installer, /github\.com|SHA256SUMS|\bgpg\b|apt-get/i, "no GitHub release, signature or package-manager dependency");
  assert.doesNotMatch(installer, /systemctl|useradd|randomBytes/, "host setup is zelavis install, not shell");
});

test("install and packaging shell scripts have valid syntax", () => {
  for (const path of [
    "installers/install.sh",
    "installers/uninstall.sh",
    "runtime/zelavis",
  ]) {
    execFileSync("sh", ["-n", new URL(path, distribution).pathname]);
  }
});

test("the Debian package does not carry the WordPress host stack; the WordPress recipe provisions it", async () => {
  const builder = await readFile(new URL("scripts/build-deb.mjs", distribution), "utf8");
  for (const dependency of ["nginx", "php-fpm", "php-mysql", "mariadb-server-core", "mariadb-client-core"]) {
    assert.doesNotMatch(builder, new RegExp(`Depends:.*\\b${dependency}\\b`));
  }
  assert.match(builder, /cli\.js install --from-release/u);
  assert.match(builder, /"opt", "zelavis", "package"/u);
  assert.doesNotMatch(builder, /symlink\(`releases/);
});

test("the Platform service reads installer-generated first-run configuration", async () => {
  const unit = await readFile(new URL("runtime/zelavis.service", distribution), "utf8");
  assert.match(unit, /^EnvironmentFile=-\/etc\/zelavis\/zelavis\.env$/m);
  assert.match(unit, /--host 127\.0\.0\.1/u);
  const host = await readFile(new URL("../../packages/zelavis/src/adapters/_install-host.ts", import.meta.url), "utf8");
  assert.match(host, /randomBytes\(32\)/u);
  assert.match(host, /First-run bootstrap token/u);
});

test("release staging bounds file hashing and includes complete uninstall", async () => {
  const builder = await readFile(new URL("scripts/build-stage.mjs", distribution), "utf8");
  assert.match(builder, /sealNodeRuntimeArtifact\(options\.output\)/u);
  const artifact = await readFile(new URL("../../packages/zelavis/src/adapters/_node-runtime-artifact.ts", import.meta.url), "utf8");
  assert.match(artifact, /concurrency: 8/u);
  assert.doesNotMatch(artifact, /Promise\.all\(files\.map/u);
  for (const flag of ["--ignore-scripts", "--omit=dev", "--omit=optional"]) assert.ok(builder.includes(flag));
  assert.match(builder, /share", "uninstall\.sh/u);
});

test("the Agent unit delegates cgroups and runs operations from the release tree", async () => {
  const unit = await readFile(new URL("runtime/zelavis-agent.service", distribution), "utf8");
  assert.match(unit, /^Delegate=yes$/m);
  assert.match(unit, /^User=zelavis$/m);
  for (const flag of [
    "--operations-root /opt/zelavis/current/operations",
    "--platform-authority /var/lib/zelavis/system/agent-authority/platform-authority.json",
    "--require-root-owned-operations",
    "--operation-cgroup delegated",
  ]) {
    assert.ok(unit.includes(flag), flag);
  }
  assert.doesNotMatch(unit, /operation-trust/, "operations carry no signature, so there is no trust store");
  const deb = await readFile(new URL("scripts/build-deb.mjs", distribution), "utf8");
  // Installed but never enabled by the package.
  assert.doesNotMatch(deb, /systemctl enable zelavis-agent/);
});

const builtRuntime = await import("node:fs").then(({ existsSync }) =>
  existsSync(new URL("../packages/zelavis/dist/core/deployment/index.js", distribution)));

test("staging writes plain manifests with the artifact digest, and refuses a template that claims one", {
  skip: !builtRuntime && "build packages/zelavis first (pnpm --filter zelavis build)",
}, async (t) => {
  const { mkdtemp, mkdir, writeFile, rm, readFile: read } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stageOperations } = await import("../scripts/stage-operations.mjs");
  const { validateHostOperationManifest } = await import("../../packages/zelavis/dist/core/deployment/index.js");
  const directory = await mkdtemp(join(tmpdir(), "zelavis-stage-operations-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const operation = join(source, "native.preflight", "v1");
  await mkdir(operation, { recursive: true });
  await writeFile(join(operation, "artifact"), "printf ok\n", { mode: 0o755 });
  await writeFile(join(operation, "operation.json"), JSON.stringify({
    id: "native.preflight", version: "v1", interpreter: "/bin/sh", arguments: {},
  }));
  const output = join(directory, "operations");
  assert.deepEqual(await stageOperations({ source, output, validate: validateHostOperationManifest }), ["native.preflight@v1"]);
  const manifest = JSON.parse(await read(join(output, "native.preflight", "v1", "manifest.json"), "utf8"));
  assert.equal(manifest.sha256, createHash("sha256").update("printf ok\n").digest("hex"));
  assert.equal(manifest.signature, undefined);
  // A template that claims a digest is refused.
  await writeFile(join(operation, "operation.json"), JSON.stringify({ id: "native.preflight", version: "v1", sha256: "a".repeat(64), arguments: {} }));
  await assert.rejects(stageOperations({ source, output: join(directory, "bad"), validate: validateHostOperationManifest }), /omit sha256/);
});

test("shipped host operation sources are valid and produce their declared result", {
  skip: !builtRuntime && "build packages/zelavis first (pnpm --filter zelavis build)",
}, async (t) => {
  const { mkdtemp, readdir, readFile: read, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { stageOperations } = await import("../scripts/stage-operations.mjs");
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
      if (template.result && Object.keys(template.arguments ?? {}).length === 0) {
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
  const staged = await stageOperations({ source, output: directory, validate: validateHostOperationManifest });
  assert.ok(staged.includes("zelavis.host-report@v1"));
  assert.ok(staged.includes("zelavis.packages-install@v1"));
  for (const operation of staged) {
    const [id, version] = operation.split("@");
    assert.equal((await stat(join(directory, id, version, "artifact"))).mode & 0o777, 0o755);
  }
});

test("named templates use the instance's private Node launcher, account, config and data, without Edge", async () => {
  const platform = await readFile(new URL("runtime/zelavis@.service", distribution), "utf8");
  const agent = await readFile(new URL("runtime/zelavis-agent@.service", distribution), "utf8");
  for (const unit of [platform, agent]) {
    assert.match(unit, /^User=zelavis-%i$/m);
    assert.match(unit, /^Group=zelavis-%i$/m);
    assert.match(unit, /ZELAVIS_DATA_DIR=\/var\/lib\/zelavis-%i/);
    assert.match(unit, /\/opt\/zelavis\/instances\/%i\/current\/bin\/zelavis/);
    assert.doesNotMatch(unit, /CAP_NET_BIND_SERVICE|zelavis-traefik/);
  }
  assert.match(platform, /serve --instance %i/);
  assert.match(platform, /EnvironmentFile=-\/etc\/zelavis-%i\/zelavis.env/);
  assert.match(agent, /Delegate=yes/);
  assert.match(agent, /\/var\/lib\/zelavis-%i\/system\/agent-authority/);
  for (const script of ["scripts/build-stage.mjs", "scripts/build-deb.mjs"]) {
    const source = await readFile(new URL(script, distribution), "utf8");
    assert.match(source, /zelavis@\.service/); assert.match(source, /zelavis-agent@\.service/);
  }
});
