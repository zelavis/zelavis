import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(
  new URL("../installers/archive-install.sh", import.meta.url),
);

/**
 * A staged tree just complete enough for the installer to run unprivileged.
 *
 * `ZELAVIS_PREFIX` is set away from /opt/zelavis, which is what lets the script
 * run without root, so the systemd branch is skipped and only the linking
 * behaviour under test executes.
 */
async function stage(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-archive-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  for (const dir of ["bin", "platform", "share", "operations", "runtime/node/bin"]) {
    await mkdir(join(source, dir), { recursive: true });
  }
  await writeFile(join(source, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
  await writeFile(join(source, "bin", "zelavis"), "#!/bin/sh\n", { mode: 0o755 });
  // The installer reads the version with the runtime it ships; the real Node
  // running this test stands in for it.
  await symlink(process.execPath, join(source, "runtime", "node", "bin", "node"));
  // The script derives its source directory from its own location, because it
  // ships inside the archive it installs. Copy it in rather than running it
  // from the repository, so the test exercises the shipped arrangement.
  const script = join(source, "archive-install.sh");
  await copyFile(installer, script);
  return {
    script,
    source,
    prefix: join(root, "prefix"),
    binDir: join(root, "bin"),
    dataDir: join(root, "data"),
  };
}

function install({ script, source, prefix, binDir, dataDir }, env = {}) {
  return spawnSync("sh", [script], {
    cwd: source,
    encoding: "utf8",
    env: {
      ...process.env,
      ZELAVIS_PREFIX: prefix,
      ZELAVIS_BIN_DIR: binDir,
      ZELAVIS_DATA_DIR: dataDir,
      ...env,
    },
  });
}

test("a clean install links the command", async (t) => {
  const tree = await stage(t);
  const result = install(tree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readlink(join(tree.binDir, "zelavis")),
    join(tree.prefix, "current", "bin", "zelavis"),
  );
});

test("installing twice is an upgrade, not a conflict", async (t) => {
  const tree = await stage(t);
  assert.equal(install(tree).status, 0);
  const second = install(tree);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /Refusing/u);
});

test("a command this installer did not create is refused, not replaced", async (t) => {
  const tree = await stage(t);
  await mkdir(tree.binDir, { recursive: true });
  const foreign = join(tree.binDir, "zelavis");
  await symlink("/usr/local/lib/node_modules/zelavis/dist/cli.js", foreign);

  const result = install(tree);
  assert.equal(result.status, 1, "the installer should have stopped");
  assert.match(result.stderr, /Refusing to replace/u);
  assert.match(result.stderr, /npm uninstall --global zelavis/u);
  // The point of refusing: the other installation is still there.
  assert.equal(
    await readlink(foreign),
    "/usr/local/lib/node_modules/zelavis/dist/cli.js",
  );
});

test("a regular file in the way is refused too", async (t) => {
  const tree = await stage(t);
  await mkdir(tree.binDir, { recursive: true });
  await writeFile(join(tree.binDir, "zelavis"), "#!/bin/sh\necho other\n", { mode: 0o755 });
  const result = install(tree);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to replace/u);
});

test("ZELAVIS_FORCE_BIN replaces it deliberately", async (t) => {
  const tree = await stage(t);
  await mkdir(tree.binDir, { recursive: true });
  await symlink("/usr/local/lib/node_modules/zelavis/dist/cli.js", join(tree.binDir, "zelavis"));

  const result = install(tree, { ZELAVIS_FORCE_BIN: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Replacing/u);
  assert.equal(
    await readlink(join(tree.binDir, "zelavis")),
    join(tree.prefix, "current", "bin", "zelavis"),
  );
});
