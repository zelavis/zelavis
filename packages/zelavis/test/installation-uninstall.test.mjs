import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION, assertCompleteUninstallConfirmation } from "../dist/core/runtime/installation.js";
import { createNodeInstallationUninstaller } from "../dist/adapters/node.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-uninstaller-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    prefix: join(root, "installation"), dataDirectory: join(root, "data"), configDirectory: join(root, "etc/zelavis"),
    commandPath: join(root, "bin/zelavis"), systemCommandPath: join(root, "usr/bin/zelavis"),
    systemdDirectories: [join(root, "systemd/etc"), join(root, "systemd/lib"), join(root, "systemd/usr")],
    aptSource: join(root, "apt/zelavis.sources"), aptKeyring: join(root, "keys/zelavis-archive-keyring.gpg"),
  };
  for (const path of [paths.prefix, paths.dataDirectory, paths.configDirectory, dirname(paths.commandPath)]) await mkdir(path, { recursive: true });
  await symlink(`${paths.prefix}/current/bin/zelavis`, paths.commandPath);
  const installation = { kind: "packaged", root: paths.prefix, path: `${paths.prefix}/current/platform/dist/cli.js` };
  return { paths, installation, skipHostCommands: true };
}

test("complete uninstall uses one explicit stable acknowledgement", () => {
  assert.doesNotThrow(() => assertCompleteUninstallConfirmation(ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION));
  assert.throws(() => assertCompleteUninstallConfirmation("yes"), /DELETE-ALL-ZELAVIS-DATA/);
});

test("the Node adapter executes its inspected plan and removes only isolated paths", async (t) => {
  const options = await fixture(t);
  const uninstaller = createNodeInstallationUninstaller(options);
  const plan = await uninstaller.plan();
  assert.equal(plan.targets.find((target) => target.id === "data").exists, true);
  assert.ok(plan.steps.some((step) => step.action.path === options.paths.aptSource));
  await assert.rejects(uninstaller.uninstall({ confirmation: "yes" }), /DELETE-ALL-ZELAVIS-DATA/);
  await access(options.paths.dataDirectory);
  const result = await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  assert.equal(result.removed, true);
  await assert.rejects(access(options.paths.prefix), { code: "ENOENT" });
  await assert.rejects(access(options.paths.dataDirectory), { code: "ENOENT" });
});

test("custom receipt paths override defaults and account ownership remains visible", async (t) => {
  const options = await fixture(t);
  const data = join(dirname(options.paths.prefix), "custom-data");
  await mkdir(data);
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify({ schemaVersion: 1, dataDirectory: data, commandPath: options.paths.commandPath, ownsUser: true, ownsGroup: true }));
  const uninstaller = createNodeInstallationUninstaller(options);
  assert.equal((await uninstaller.plan()).dataDirectory, data);
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(data), { code: "ENOENT" });
  await access(options.paths.dataDirectory);
});

test("the Node host adapter refuses source and npm copies", () => {
  for (const kind of ["source", "npm"]) assert.throws(() => createNodeInstallationUninstaller({ installation: { kind, path: `/tmp/${kind}/dist/cli.js`, root: `/tmp/${kind}` } }), /only to a packaged/);
});

test("the Node adapter refuses broad, non-normalized and external CLI paths", async (t) => {
  const options = await fixture(t);
  assert.throws(() => createNodeInstallationUninstaller({ ...options, installation: { kind: "packaged", root: "/", path: "/opt/zelavis/cli.js" } }), /unsafe installation root/);
  await assert.rejects(createNodeInstallationUninstaller({ ...options, dataDirectory: "/tmp/project/.." }).plan(), /non-normalized data directory/);
  assert.throws(() => createNodeInstallationUninstaller({ ...options, installation: { ...options.installation, path: "/outside/cli.js" } }), /outside the packaged/);
});


test("a Debian receipt after an archive removes both owned command links", async (t) => {
  const options = await fixture(t);
  await mkdir(dirname(options.paths.systemCommandPath), { recursive: true });
  await symlink(`${options.paths.prefix}/current/bin/zelavis`, options.paths.systemCommandPath);
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify({ schemaVersion: 1, dataDirectory: options.paths.dataDirectory, commandPath: options.paths.systemCommandPath, ownsUser: false, ownsGroup: false }));
  const uninstaller = createNodeInstallationUninstaller(options);
  const plan = await uninstaller.plan();
  assert.ok(plan.targets.some((target) => target.path === options.paths.commandPath));
  assert.ok(plan.targets.some((target) => target.path === options.paths.systemCommandPath));
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(options.paths.commandPath), { code: "ENOENT" });
  await assert.rejects(access(options.paths.systemCommandPath), { code: "ENOENT" });
});
