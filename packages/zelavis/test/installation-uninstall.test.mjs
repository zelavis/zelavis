import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION, assertCompleteUninstallConfirmation } from "../dist/core/runtime/installation.js";
import { createNodeInstallationUninstaller } from "../dist/adapters/node.js";

const receipt = (paths, overrides = {}) => ({ schemaVersion: 2, port: 3000, edge: true, mode: "system", source: "release", instance: "default", installedBy: "archive", version: "1.0.0", prefix: paths.prefix, configDirectory: paths.configDirectory, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, ownsUser: false, ownsGroup: false, ...overrides });

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
  await writeFile(`${paths.prefix}/installation.json`, JSON.stringify(receipt(paths)));
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
  assert.equal(plan.targets.find((target) => target.id === "data").kind, "directory");
  assert.equal(new Set(plan.targets.map((target) => target.id)).size, plan.targets.length);
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
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify(receipt(options.paths, { dataDirectory: data, ownsUser: true, ownsGroup: true })));
  const uninstaller = createNodeInstallationUninstaller(options);
  assert.equal((await uninstaller.plan()).dataDirectory, data);
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(data), { code: "ENOENT" });
  await access(options.paths.dataDirectory);
});

test("the Node host adapter refuses source and npm copies without installer receipts", async () => {
  for (const kind of ["source", "npm"]) await assert.rejects(createNodeInstallationUninstaller({ installation: { kind, path: `/tmp/${kind}/dist/cli.js`, root: `/tmp/${kind}` } }).plan(), /originating lifecycle/);
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
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify(receipt(options.paths, { commandPath: options.paths.systemCommandPath })));
  const uninstaller = createNodeInstallationUninstaller(options);
  const plan = await uninstaller.plan();
  assert.ok(plan.targets.some((target) => target.path === options.paths.commandPath));
  assert.ok(plan.targets.some((target) => target.path === options.paths.systemCommandPath));
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(options.paths.commandPath), { code: "ENOENT" });
  await assert.rejects(access(options.paths.systemCommandPath), { code: "ENOENT" });
});

test("user uninstall removes its entire inventory and cannot touch system units, APT or commands", async (t) => {
  const options = await fixture(t);
  options.paths.dataDirectory = join(options.paths.prefix, "data");
  options.paths.configDirectory = join(options.paths.prefix, "config");
  for (const path of [options.paths.dataDirectory, options.paths.configDirectory, options.paths.systemdDirectories[0], dirname(options.paths.aptSource), dirname(options.paths.aptKeyring), dirname(options.paths.systemCommandPath)]) await mkdir(path, { recursive: true });
  const retained = [join(options.paths.systemdDirectories[0], "zelavis.service"), options.paths.aptSource, options.paths.aptKeyring, options.paths.systemCommandPath];
  for (const path of retained) await writeFile(path, "operator/system state");
  await writeFile(join(options.paths.configDirectory, "zelavis.env"), "private first-owner token", { mode: 0o600 });
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify(receipt(options.paths, { mode: "user", edge: false, source: "package", installedBy: "create" })));
  const uninstaller = createNodeInstallationUninstaller(options);
  await assert.rejects(createNodeInstallationUninstaller({ ...options, dataDirectory: "/outside/user-data" }).plan(), /does not match/);
  const plan = await uninstaller.plan();
  assert.ok(plan.steps.every((step) => ["remove", "remove-link", "reserve-data"].includes(step.action.kind)));
  assert.ok(!plan.targets.some((target) => retained.includes(target.path)));
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(options.paths.prefix), { code: "ENOENT" });
  await assert.rejects(access(options.paths.commandPath), { code: "ENOENT" });
  for (const path of retained) await access(path);
});


for (const kind of ["npm", "source"]) test(`a ${kind} identity with a current package receipt uses the shared removal inventory`, async (t) => {
  const options = await fixture(t);
  await writeFile(`${options.paths.prefix}/installation.json`, JSON.stringify(receipt(options.paths, { source: "package", installedBy: "create" })));
  const uninstaller = createNodeInstallationUninstaller({ ...options, installation: { ...options.installation, kind } });
  assert.equal((await uninstaller.plan()).dataDirectory, options.paths.dataDirectory);
  await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  await assert.rejects(access(options.paths.prefix), { code: "ENOENT" });
});

test("complete uninstall refuses live data ownership and does not delete operator state", async (t) => {
  const options = await fixture(t);
  const { acquireLocalDataOwnership } = await import("../dist/adapters/_local-ownership.js");
  const lease = await acquireLocalDataOwnership(options.paths.dataDirectory);
  t.after(() => lease.release());
  await assert.rejects(createNodeInstallationUninstaller(options).uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION }), /owned by running PID/);
  await access(options.paths.dataDirectory);
  await access(`${options.paths.prefix}/installation.json`);
  await lease.release();
});

for (const first of ["default", "preview"]) test(`isolated destructive inventory removes ${first} first and preserves the other instance`, async (t) => {
  const options = await fixture(t);
  const { claimLocalEdgeOwner } = await import("../dist/adapters/_local-ownership.js");
  const named = { ...options.paths, instance: "preview", dataDirectory: `${options.paths.dataDirectory}-preview`, configDirectory: `${options.paths.configDirectory}-preview` };
  const scope = `${options.paths.prefix}/instances/preview`;
  await mkdir(scope, {recursive: true});
  await mkdir(named.dataDirectory); await mkdir(named.configDirectory);
  await mkdir(options.paths.systemdDirectories[0], {recursive: true});
  await mkdir(dirname(options.paths.aptSource), {recursive: true});
  await writeFile(options.paths.aptSource, "shared source");
  const template = `${options.paths.systemdDirectories[0]}/zelavis@.service`;
  await writeFile(template, "shared instance template");
  await writeFile(`${scope}/installation.json`, JSON.stringify(receipt(named, {instance: "preview", port: 3100, edge: false})));
  await writeFile(`${scope}/runtime.json`, "public descriptor");
  await writeFile(`${options.paths.prefix}/runtime.json`, "default public descriptor");
  await symlink(`${options.paths.prefix}/releases/1.0.0`, `${scope}/current`);
  await mkdir(`${options.paths.prefix}/releases/1.0.0`, {recursive: true});
  await writeFile(`${options.paths.prefix}/releases/1.0.0/private-runtime`, "shared release");
  await mkdir(`${options.paths.prefix}/package`, {recursive: true});
  await writeFile(`${options.paths.prefix}/package/incoming-payload`, "shared Debian payload");
  await writeFile(`${named.dataDirectory}/project.sqlite`, "preview project");
  await writeFile(`${options.paths.dataDirectory}/project.sqlite`, "default project");
  await claimLocalEdgeOwner({prefix: options.paths.prefix, instance: "default", dataDirectory: options.paths.dataDirectory});
  const remove = (instance) => createNodeInstallationUninstaller({...options, instance}).uninstall({confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION});
  const inventory = await createNodeInstallationUninstaller({...options, instance: first}).plan();
  assert.ok(!inventory.steps.some((step) => step.action.path === options.paths.prefix || step.action.kind === "purge-packages"));
  await remove(first);
  for (const path of [template, options.paths.aptSource, `${options.paths.prefix}/package/incoming-payload`, `${options.paths.prefix}/releases/1.0.0/private-runtime`]) await access(path);
  // lstat the command because this fixture deliberately has no runnable launcher.
  const { lstat } = await import("node:fs/promises"); await lstat(options.paths.commandPath);
  const remaining = first === "default" ? named : options.paths;
  await access(`${remaining.dataDirectory}/project.sqlite`);
  await access(remaining.configDirectory);
  if (first === "preview") { await access(`${options.paths.prefix}/edge-owner.json`); await access(`${options.paths.prefix}/.edge-owner.lock`); }
  else { await assert.rejects(access(`${options.paths.prefix}/edge-owner.json`), {code: "ENOENT"}); await assert.rejects(access(`${options.paths.prefix}/.edge-owner.lock`), {code: "ENOENT"}); }
  await remove(first === "default" ? "preview" : "default");
  for (const path of [options.paths.prefix, named.dataDirectory, options.paths.dataDirectory, template, options.paths.aptSource]) await assert.rejects(access(path), {code: "ENOENT"});
});


test("a live Edge reservation refuses destructive removal before deleting configuration or data", async (t) => {
  const options = await fixture(t);
  const { claimLocalEdgeOwner, acquireLocalEdgeOwnership } = await import("../dist/adapters/_local-ownership.js");
  const selection = {prefix: options.paths.prefix, instance: "default", dataDirectory: options.paths.dataDirectory};
  await claimLocalEdgeOwner(selection);
  const lease = await acquireLocalEdgeOwnership(selection);
  t.after(() => lease.release());
  await assert.rejects(createNodeInstallationUninstaller(options).uninstall({confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION}), /already reserved/);
  await access(options.paths.configDirectory); await access(options.paths.dataDirectory);
  await access(`${options.paths.prefix}/installation.json`);
  await lease.release();
});
