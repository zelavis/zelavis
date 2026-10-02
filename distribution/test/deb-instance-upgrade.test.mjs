import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { freePort, stageCli } from "./staged-cli.mjs";

const distribution = fileURLToPath(new URL("../", import.meta.url));
test("Debian payload replacement leaves independently selected persistent releases intact", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zelavis-deb-instances-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const prefix = join(root, "host/opt/zelavis");
  const packageRoot = join(distribution, ".tmp/deb-root");
  const toolsPath = join(root, "tools");
  await mkdir(toolsPath);
  // Permit genuine port/lock probes while keeping systemctl/account tools unavailable.
  if (process.platform === "darwin") await symlink("/usr/sbin/lsof", join(toolsPath, "lsof"));
  if (process.platform === "linux") {
    await symlink("/usr/bin/flock", join(toolsPath, "flock"));
    // The lock holder uses cat to wait for EOF from the installing process.
    await symlink("/bin/cat", join(toolsPath, "cat"));
  }
  const environment = {...process.env, PATH: toolsPath, ZELAVIS_PREFIX: prefix, ZELAVIS_DATA_DIR: join(root, "host/data"), ZELAVIS_UNINSTALL_ETC_DIR: join(root, "host/config"), ZELAVIS_BIN_DIR: join(root, "host/bin"), ZELAVIS_UNINSTALL_SYSTEM_BIN: join(root, "host/usr/bin/zelavis"), ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR: join(root, "host/units/etc"), ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR: join(root, "host/units/lib"), ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR: join(root, "host/units/usr")};
  async function unpack(version) {
    const stage = join(root, `stage-${version}`);
    for (const path of ["bin", "runtime/node/bin", "share"]) await mkdir(join(stage, path), {recursive: true});
    await stageCli(stage);
    await writeFile(join(stage, "manifest.json"), JSON.stringify({version, platform: "linux", architecture: "x64"}));
    await writeFile(join(stage, "bin/zelavis"), "#!/bin/sh\n", {mode: 0o755});
    await symlink(process.execPath, join(stage, "runtime/node/bin/node"));
    for (const unit of ["zelavis.service", "zelavis-agent.service", "zelavis-traefik.service", "zelavis@.service", "zelavis-agent@.service", "zelavis-update.service", "zelavis-update.path", "traefik.yml"]) await cp(join(distribution, "runtime", unit), join(stage, "share", unit));
    execFileSync(process.execPath, [join(distribution, "scripts/build-deb.mjs"), "--stage", stage, "--prepare-only"], {stdio: "pipe"});
    // The actual prepared package must contain no dpkg-owned releases/current.
    const owned = join(packageRoot, "opt/zelavis");
    assert.deepEqual(await readdir(owned), ["package"]);
    const postinst = await readFile(join(packageRoot, "DEBIAN/postinst"), "utf8");
    assert.match(postinst, /\/opt\/zelavis\/package\/runtime\/node\/bin\/node/);
    assert.match(postinst, /--from-release \/opt\/zelavis\/package --installed-by deb/);
    assert.equal(await readlink(join(packageRoot, "usr/bin/zelavis")), "/opt/zelavis/current/bin/zelavis");
    // Model dpkg replacing only the files the new package actually owns.
    await mkdir(prefix, {recursive: true});
    await rm(join(prefix, "package"), {recursive: true, force: true});
    await cp(join(owned, "package"), join(prefix, "package"), {recursive: true});
  }
  const defaultPort = String(await freePort());
  function install(args = []) {
    const result = spawnSync(process.execPath, [join(prefix, "package/platform/dist/cli.js"), "install", "--from-release", join(prefix, "package"), "--installed-by", "deb", ...args.includes("--port") ? [] : ["--port", defaultPort], ...args], {encoding: "utf8", env: environment});
    assert.equal(result.status, 0, result.stderr);
  }
  await unpack("1.0.0"); install(); install(["--instance", "preview", "--port", "3100"]);
  const namedLink = join(prefix, "instances/preview/current");
  assert.equal(await readlink(namedLink), join(prefix, "releases/1.0.0"));
  await unpack("2.0.0");
  assert.equal(await readlink(join(prefix, "current")), join(prefix, "releases/1.0.0"), "dpkg must not switch a Platform before preflight");
  install();
  assert.equal(await readlink(join(prefix, "current")), join(prefix, "releases/2.0.0"));
  assert.equal(await readlink(namedLink), join(prefix, "releases/1.0.0"));
  assert.equal(JSON.parse(await readFile(join(namedLink, "manifest.json"), "utf8")).version, "1.0.0");
  assert.equal(JSON.parse(await readFile(join(prefix, "instances/preview/installation.json"), "utf8")).version, "1.0.0");
});
