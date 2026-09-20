import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  const root = await mkdtemp(join(tmpdir(), "zelavis-complete-uninstall-"));
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
    aptSource: join(root, "etc", "apt", "sources.list.d", "zelavis.sources"),
    aptKeyring: join(root, "usr", "share", "keyrings", "zelavis-archive-keyring.gpg"),
  };
  for (const path of [
    paths.prefix,
    paths.data,
    paths.etc,
    paths.bin,
    paths.systemdEtc,
    paths.systemdLib,
    paths.systemdUsrLib,
    dirname(paths.aptSource),
    dirname(paths.aptKeyring),
    dirname(paths.systemBin),
  ]) {
    await mkdir(path, { recursive: true });
  }
  await writeFile(join(paths.data, "project.sqlite"), "data");
  await writeFile(join(paths.etc, "operation-trust.json"), "{}");
  await writeFile(paths.aptSource, "source");
  await writeFile(paths.aptKeyring, "key");
  for (const directory of [paths.systemdEtc, paths.systemdLib]) {
    await writeFile(join(directory, "zelavis.service"), "unit");
    await writeFile(join(directory, "zelavis-agent.service"), "unit");
    await writeFile(join(directory, "zelavis-traefik.service"), "unit");
  }
  const command = join(paths.bin, "zelavis");
  await symlink(join(paths.prefix, "current", "bin", "zelavis"), command);

  return {
    paths,
    command,
    env: {
      ...process.env,
      ZELAVIS_PREFIX: paths.prefix,
      ZELAVIS_DATA_DIR: paths.data,
      ZELAVIS_UNINSTALL_ETC_DIR: paths.etc,
      ZELAVIS_BIN_DIR: paths.bin,
      ZELAVIS_UNINSTALL_SYSTEM_BIN: paths.systemBin,
      ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR: paths.systemdEtc,
      ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR: paths.systemdLib,
      ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR: paths.systemdUsrLib,
      ZELAVIS_UNINSTALL_APT_SOURCE: paths.aptSource,
      ZELAVIS_UNINSTALL_APT_KEYRING: paths.aptKeyring,
      ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS: "1",
    },
  };
}

function run(args, env) {
  return spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env,
  });
}

test("complete uninstall dry-run lists scope and changes nothing", async (t) => {
  const fixture = await installation(t);
  const result = run(["--dry-run"], fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Complete Zelavis uninstall plan/u);
  assert.equal(await exists(fixture.paths.data), true);
  assert.equal(await readlink(fixture.command), join(fixture.paths.prefix, "current", "bin", "zelavis"));
});

test("complete uninstall refuses without the exact acknowledgement", async (t) => {
  const fixture = await installation(t);
  const result = run(["--confirm", "yes"], fixture.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DELETE-ALL-ZELAVIS-DATA/u);
  assert.equal(await exists(fixture.paths.prefix), true);
});

test("complete uninstall refuses broad and non-normalized owned paths", async (t) => {
  const fixture = await installation(t);
  const broad = run(["--dry-run"], {
    ...fixture.env,
    ZELAVIS_DATA_DIR: "/tmp",
  });
  assert.equal(broad.status, 1);
  assert.match(broad.stderr, /unsafe data directory/u);

  const nonNormalized = run(["--dry-run"], {
    ...fixture.env,
    ZELAVIS_DATA_DIR: `${fixture.paths.data}/../data`,
  });
  assert.equal(nonNormalized.status, 1);
  assert.match(nonNormalized.stderr, /non-normalized data directory/u);

  const foreignAptFile = run(["--dry-run"], {
    ...fixture.env,
    ZELAVIS_UNINSTALL_APT_SOURCE: join(
      dirname(fixture.paths.aptSource),
      "other.sources",
    ),
  });
  assert.equal(foreignAptFile.status, 1);
  assert.match(foreignAptFile.stderr, /name is not zelavis\.sources/u);

  const invalidOwnership = run(["--dry-run"], {
    ...fixture.env,
    ZELAVIS_UNINSTALL_OWNS_USER: "maybe",
  });
  assert.equal(invalidOwnership.status, 1);
  assert.match(invalidOwnership.stderr, /invalid installer account ownership/u);
  assert.equal(await exists(fixture.paths.data), true);
});

test("complete uninstall removes every installer-owned custom-path artifact", async (t) => {
  const fixture = await installation(t);
  const result = run(
    ["--confirm", "DELETE-ALL-ZELAVIS-DATA"],
    fixture.env,
  );
  assert.equal(result.status, 0, result.stderr);
  for (const path of [
    fixture.paths.prefix,
    fixture.paths.data,
    fixture.paths.etc,
    fixture.paths.aptSource,
    fixture.paths.aptKeyring,
    fixture.command,
    join(fixture.paths.systemdEtc, "zelavis.service"),
    join(fixture.paths.systemdEtc, "zelavis-traefik.service"),
    join(fixture.paths.systemdLib, "zelavis-agent.service"),
    join(fixture.paths.systemdLib, "zelavis-traefik.service"),
  ]) {
    assert.equal(await exists(path), false, `${path} should be removed`);
  }
});
