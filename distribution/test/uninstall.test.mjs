import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stageCli } from "./staged-cli.mjs";

const script = fileURLToPath(
  new URL("../installers/uninstall.sh", import.meta.url),
);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function installation(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zelavis-complete-uninstall-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    prefix: join(root, "opt", "zelavis"),
    data: join(root, "var", "lib", "zelavis"),
    etc: join(root, "etc", "zelavis"),
    bin: join(root, "usr", "local", "bin"),
    systemBin: join(root, "usr", "bin", "zelavis"),
    systemdEtc: join(root, "etc", "systemd", "system"),
    systemdLib: join(root, "lib", "systemd", "system"),
    systemdUsrLib: join(root, "usr", "lib", "systemd", "system"),
  };
  for (const path of [
    paths.prefix,
    paths.data,
    paths.etc,
    paths.bin,
    paths.systemdEtc,
    paths.systemdLib,
    paths.systemdUsrLib,
    dirname(paths.systemBin),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(paths.prefix, "installation.json"), JSON.stringify({ schemaVersion: 2, port: 3000, edge: true, mode: "system", source: "release", instance: "default", installedBy: "script", version: "1.0.0", prefix: paths.prefix, configDirectory: paths.etc, dataDirectory: paths.data, commandPath: join(paths.bin, "zelavis"), ownsUser: false, ownsGroup: false }));
  await writeFile(join(paths.data, "project.sqlite"), "data");
  await mkdir(join(paths.prefix, "package"));
  await writeFile(join(paths.prefix, "package", "incoming-payload"), "Debian payload");
  await writeFile(join(paths.prefix, ".install.lock"), "");
  await writeFile(join(paths.prefix, "runtime.json"), "public descriptor");
  await writeFile(join(paths.prefix, ".edge-owner.lock"), "");
  await writeFile(join(paths.prefix, "edge-owner.json"), JSON.stringify({schemaVersion: 1, prefix: paths.prefix, instance: "default", dataDirectory: paths.data}));
  await writeFile(join(paths.data, ".platform.lock"), "");
  for (const name of ["runtime-control.sock", "runtime-custody.json", "runtime-handover.json", "runtime-handover.json.guard.sqlite", ".runtime-owner.sqlite"]) await writeFile(join(paths.data, name), "abandoned host state");
  for (const name of ["runtime-engines", "runtime-agent"]) {
    await mkdir(join(paths.data, name)); await writeFile(join(paths.data, name, "owned-state"), "host state");
  }
  await writeFile(join(paths.data, ".platform-owner.json"), JSON.stringify({ pid: 2147483647, startedAt: "1970-01-01T00:00:00.000Z", session: "crashed-platform", purpose: "platform", installationRoot: paths.prefix }));
  for (const directory of [paths.systemdEtc, paths.systemdLib]) {
    await writeFile(join(directory, "zelavis.service"), "unit");
    await writeFile(join(directory, "zelavis@.service"), "instance unit");
    await writeFile(join(directory, "zelavis-agent@.service"), "instance agent unit");
    await writeFile(join(directory, "zelavis-agent.service"), "unit");
    await writeFile(join(directory, "zelavis-traefik.service"), "unit");
    await writeFile(join(directory, "zelavis-update.service"), "unit");
    await writeFile(join(directory, "zelavis-update.path"), "unit");
    await writeFile(join(directory, "zelavis.socket"), "unit");
  }
  const release = join(paths.prefix, "current");
  await stageCli(release);
  await mkdir(join(release, "runtime/node/bin"), { recursive: true });
  await symlink(process.execPath, join(release, "runtime/node/bin/node"));
  await mkdir(join(release, "share"), { recursive: true });
  const stagedScript = join(release, "share/uninstall.sh");
  await copyFile(script, stagedScript);
  const command = join(paths.bin, "zelavis");
  await symlink(join(paths.prefix, "current", "bin", "zelavis"), command);

  return {
    paths,
    command,
    script: stagedScript,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ZELAVIS_PREFIX: paths.prefix,
      ZELAVIS_DATA_DIR: paths.data,
      ZELAVIS_UNINSTALL_ETC_DIR: paths.etc,
      ZELAVIS_BIN_DIR: paths.bin,
      ZELAVIS_UNINSTALL_SYSTEM_BIN: paths.systemBin,
      ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR: paths.systemdEtc,
      ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR: paths.systemdLib,
      ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR: paths.systemdUsrLib,
      ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS: "1",
    },
  };
}

function run(args, fixture) {
  return spawnSync("sh", [fixture.script, ...args], {
    encoding: "utf8",
    env: fixture.env,
  });
}

test("complete uninstall dry-run lists scope and changes nothing", async (t) => {
  const fixture = await installation(t);
  const result = run(["--dry-run"], fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Complete Zelavis uninstall plan/u);
  assert.equal(await exists(fixture.paths.data), true);
  assert.equal(await readlink(fixture.command), join(fixture.paths.prefix, "current", "bin", "zelavis"));
});

test("complete uninstall refuses without the exact acknowledgement", async (t) => {
  const fixture = await installation(t);
  const result = run(["--confirm", "yes"], fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DELETE-ALL-ZELAVIS-DATA/u);
  assert.equal(await exists(fixture.paths.prefix), true);
});

test("complete uninstall refuses broad and non-normalized owned paths", async (t) => {
  const fixture = await installation(t);
  const broad = run(["--dry-run"], {
    ...fixture, env: { ...fixture.env,
    ZELAVIS_DATA_DIR: "/tmp",
  } });
  assert.equal(broad.status, 1);
  assert.match(broad.stderr, /unsafe data directory/u);

  const nonNormalized = run(["--dry-run"], {
    ...fixture, env: { ...fixture.env,
    ZELAVIS_DATA_DIR: `${fixture.paths.data}/../data`,
  } });
  assert.equal(nonNormalized.status, 1);
  assert.match(nonNormalized.stderr, /non-normalized data directory/u);

  const invalidOwnership = run(["--dry-run"], {
    ...fixture, env: { ...fixture.env,
    ZELAVIS_UNINSTALL_OWNS_USER: "maybe",
  } });
  assert.equal(invalidOwnership.status, 1);
  assert.match(invalidOwnership.stderr, /invalid installer account ownership/u);
  assert.equal(await exists(fixture.paths.data), true);
});

test("complete uninstall removes every installer-owned custom-path artifact", async (t) => {
  const fixture = await installation(t);
  const result = run(
    ["--confirm", "DELETE-ALL-ZELAVIS-DATA"],
    fixture,
  );
  assert.equal(result.status, 0, result.stderr);
  for (const path of [
    ...["runtime-control.sock", "runtime-custody.json", "runtime-handover.json", "runtime-handover.json.guard.sqlite", ".runtime-owner.sqlite", "runtime-engines", "runtime-agent"].map(name => join(fixture.paths.data, name)),
    join(fixture.paths.prefix, ".install.lock"),
    join(fixture.paths.prefix, "installation.json"),
    join(fixture.paths.prefix, "runtime.json"),
    join(fixture.paths.prefix, "package", "incoming-payload"),
    join(fixture.paths.prefix, "edge-owner.json"),
    join(fixture.paths.prefix, ".edge-owner.lock"),
    join(fixture.paths.data, ".platform.lock"),
    join(fixture.paths.data, ".platform-owner.json"),
    fixture.paths.prefix,
    fixture.paths.data,
    fixture.paths.etc,
    fixture.command,
    join(fixture.paths.systemdEtc, "zelavis.service"),
    join(fixture.paths.systemdEtc, "zelavis@.service"),
    join(fixture.paths.systemdLib, "zelavis-agent@.service"),
    join(fixture.paths.systemdEtc, "zelavis-traefik.service"),
    join(fixture.paths.systemdLib, "zelavis-agent.service"),
    join(fixture.paths.systemdLib, "zelavis-traefik.service"),
    join(fixture.paths.systemdEtc, "zelavis-update.service"),
    join(fixture.paths.systemdEtc, "zelavis-update.path"),
    join(fixture.paths.systemdEtc, "zelavis.socket"),
    join(fixture.paths.systemdLib, "zelavis-update.service"),
    join(fixture.paths.systemdLib, "zelavis-update.path"),
  ]) {
    assert.equal(await exists(path), false, `${path} should be removed`);
  }
});
