// The worker installation role: the plan, its refusals, its removal and the CLI.
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION } from "../dist/core/runtime/installation.js";
import { executeZelavisInstallationPlan, planZelavisReleaseInstall, readInstallationRole, readNativeInstallationReceipt } from "../dist/core/runtime/installation-plan.js";
import {
  WORKER_ACCOUNT, WORKER_UNITS, installationReceiptPath, planZelavisWorkerInstall, planZelavisWorkerUninstall, readWorkerReceipt,
} from "../dist/core/runtime/worker-installation-plan.js";
import { createNodeInstallationUninstaller } from "../dist/adapters/node.js";
import { runReleaseInstall } from "../dist/cli/install/index.js";

const unit = (file) => readFile(new URL(`../../../distribution/runtime/${file}`, import.meta.url), "utf8");
const TEMPLATES = Object.fromEntries(await Promise.all([...WORKER_UNITS, "zelavis.service", "zelavis.socket"].map(async (file) => [file, await unit(file)])));

const paths = {
  prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis-worker", commandPath: "/usr/local/bin/zelavis", systemCommandPath: "/usr/bin/zelavis",
  systemdDirectories: ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"],
};

class FakeHost {
  files = new Map(); links = new Map(); directories = new Set(); accounts = new Set(); actions = [];
  constructor(version = "1.0.0") { this.release(version); }
  release(version, { omit = [] } = {}) {
    this.files.set("/stage/manifest.json", JSON.stringify({ version }));
    for (const [file, content] of Object.entries(TEMPLATES)) if (!omit.includes(file)) this.files.set(`/stage/share/${file}`, content);
  }
  async exists(path) { return this.links.has(path) || this.files.has(path) || this.directories.has(path); }
  async read(path) { return this.files.get(path); }
  async readlink(path) { return this.links.get(path); }
  async which() { return undefined; }
  async accountExists(kind, name) { return this.accounts.has(`${kind}:${name}`); }
  async execute(action) {
    this.actions.push(action);
    switch (action.kind) {
      case "mkdir": this.directories.add(action.path); break;
      case "copy":
        this.directories.add(action.path);
        for (const [path, content] of [...this.files]) if (path.startsWith(`${action.source}/`)) this.files.set(action.path + path.slice(action.source.length), content);
        break;
      case "link": this.links.set(action.path, action.target); break;
      case "write": this.files.set(action.path, action.content); break;
      case "command":
        if (action.command === "groupadd") this.accounts.add(`group:${action.args.at(-1)}`);
        if (action.command === "useradd") this.accounts.add(`user:${action.args.at(-1)}`);
        break;
    }
  }
}

const install = (host, extra = {}) => planZelavisWorkerInstall({ host, source: "/stage", paths, ...extra });
const ids = (plan) => plan.steps.map((step) => step.id);
const receiptOf = (host) => JSON.parse(host.files.get(installationReceiptPath(paths.prefix)));

test("the plan creates one dedicated account, its unit and path unit, and records an inventory first", async () => {
  const host = new FakeHost();
  const plan = await install(host);
  assert.equal(plan.operation, "install");
  assert.equal(plan.steps[4].id, "initial-receipt", "the receipt exists before anything it inventories");
  assert.ok(ids(plan).indexOf("initial-receipt") < ids(plan).indexOf("release"));
  assert.ok(ids(plan).indexOf("initial-receipt") < ids(plan).indexOf("group"));
  const commands = plan.steps.filter((step) => step.action.kind === "command").map((step) => `${step.action.command} ${step.action.args.join(" ")}`);
  assert.ok(commands.includes(`groupadd --system ${WORKER_ACCOUNT}`));
  assert.ok(commands.some((c) => c.startsWith(`useradd --system --gid ${WORKER_ACCOUNT} --home-dir /var/lib/zelavis-worker --shell /usr/sbin/nologin`)));
  assert.ok(commands.includes("systemctl enable --now zelavis-worker.path"));
  assert.ok(!commands.some((c) => /zelavis\.service|zelavis\.socket|traefik|zelavis-agent|host-agent|zelavis-update/.test(c)), "no Platform unit is touched");
  await executeZelavisInstallationPlan(host, plan);
  for (const name of WORKER_UNITS) assert.ok(host.files.has(`/etc/systemd/system/${name}`), name);
  assert.deepEqual(receiptOf(host), {
    schemaVersion: 3, role: "worker", version: "1.0.0", installedBy: "cli", prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis-worker",
    commandPath: "/usr/local/bin/zelavis", account: WORKER_ACCOUNT, ownsUser: true, ownsGroup: true,
  });
});

test("the plan carries no credential, so a dry run cannot leak one", async () => {
  const plan = await install(new FakeHost());
  const text = JSON.stringify(plan);
  assert.ok(!/token|secret|password|credential/i.test(text), "no credential or secret is in the plan");
  assert.ok(!plan.steps.some((step) => step.action.kind === "bootstrap"));
});

test("the worker unit runs the Agent as its own account and only once the machine has joined", async () => {
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  const service = host.files.get("/etc/systemd/system/zelavis-worker.service");
  assert.match(service, /^User=zelavis-worker$/m);
  assert.match(service, /^ConditionPathExists=\/var\/lib\/zelavis-worker\/worker\/remote-project\.json$/m);
  assert.match(service, /--remote-project-config \/var\/lib\/zelavis-worker\/worker\/remote-project\.json/);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(host.files.get("/etc/systemd/system/zelavis-worker.path"), /^PathExists=\/var\/lib\/zelavis-worker\/worker\/remote-project\.json$/m);
});

test("units are rendered for the prefix and data directory this host actually uses", async () => {
  const host = new FakeHost();
  const other = { ...paths, prefix: "/srv-test/zv", dataDirectory: "/srv-test/worker-data" };
  await executeZelavisInstallationPlan(host, await planZelavisWorkerInstall({ host, source: "/stage", paths: other }));
  const service = host.files.get("/etc/systemd/system/zelavis-worker.service");
  assert.ok(!service.includes("/opt/zelavis") && !service.includes("/var/lib/zelavis-worker"));
  assert.match(service, /ExecStart=\/srv-test\/zv\/current\/bin\/zelavis agent/);
  assert.match(service, /--data-dir \/srv-test\/worker-data/);
});

test("installing again is an update: nothing is recreated, ownership is kept, a running Agent is restarted", async () => {
  const host = new FakeHost("1.0.0");
  await executeZelavisInstallationPlan(host, await install(host));
  host.release("1.1.0");
  const again = await install(host);
  assert.ok(!ids(again).includes("group") && !ids(again).includes("user"), "accounts already exist");
  const restart = again.steps.find((step) => step.id === "worker-restart");
  assert.deepEqual([restart.action.args, restart.action.ignoreFailure], [["try-restart", "zelavis-worker.service"], true]);
  await executeZelavisInstallationPlan(host, again);
  assert.equal(receiptOf(host).version, "1.1.0");
  assert.equal(receiptOf(host).ownsUser, true, "it still owns the account it created");
  assert.equal(host.links.get("/opt/zelavis/current"), "/opt/zelavis/releases/1.1.0");
});

test("a first install does not try to restart anything", async () => {
  assert.ok(!ids(await install(new FakeHost())).includes("worker-restart"));
});

test("an account that already existed is not claimed, so it is never removed", async () => {
  const host = new FakeHost();
  host.accounts.add(`group:${WORKER_ACCOUNT}`).add(`user:${WORKER_ACCOUNT}`);
  const plan = await install(host);
  assert.ok(!ids(plan).includes("group") && !ids(plan).includes("user"));
  await executeZelavisInstallationPlan(host, plan);
  assert.deepEqual([receiptOf(host).ownsUser, receiptOf(host).ownsGroup], [false, false]);
});

test("a machine is a Platform or a worker, in both directions", async () => {
  const host = new FakeHost();
  host.files.set("/opt/zelavis/installation.json", JSON.stringify({ schemaVersion: 3, role: "platform" }));
  await assert.rejects(() => install(host), /Platform is installed here/);
  const workerHost = new FakeHost();
  await executeZelavisInstallationPlan(workerHost, await install(workerHost));
  await assert.rejects(() => planZelavisReleaseInstall({
    host: workerHost, source: "/stage", system: true,
    paths: { ...paths, dataDirectory: "/var/lib/zelavis", configDirectory: "/etc/zelavis" },
  }), /machine is a Zelavis worker/);
});

test("a downgrade, a moved data directory and a foreign command are refused", async () => {
  const host = new FakeHost("2.0.0");
  await executeZelavisInstallationPlan(host, await install(host));
  host.release("1.0.0");
  await assert.rejects(() => install(host), /Refusing downgrade from 2\.0\.0 to 1\.0\.0/);
  assert.ok(await install(host, { allowDowngrade: true }));
  await assert.rejects(() => planZelavisWorkerInstall({ host, source: "/stage", paths: { ...paths, dataDirectory: "/var/lib/elsewhere" } }), /refusing to move it/);

  const foreign = new FakeHost();
  foreign.links.set(paths.commandPath, "/usr/lib/node_modules/zelavis/bin/zelavis");
  await assert.rejects(() => install(foreign), /did not create/);
  const forced = await install(foreign, { force: true });
  assert.match(forced.warnings.join("\n"), /Replacing \/usr\/local\/bin\/zelavis deliberately/);
});

test("a release without the worker units is refused, and a malformed receipt is reported", async () => {
  const host = new FakeHost();
  host.files.delete("/stage/share/zelavis-worker.path");
  await assert.rejects(() => install(host), /missing share\/zelavis-worker\.path/);
  const bad = new FakeHost();
  bad.files.set(installationReceiptPath("/opt/zelavis"), JSON.stringify({ schemaVersion: 3, role: "worker", nonsense: true }));
  await assert.rejects(() => readWorkerReceipt(bad, "/opt/zelavis"));
  assert.equal(await readWorkerReceipt(new FakeHost(), "/opt/zelavis"), undefined);
});

test("every path is validated before a step is planned", async () => {
  for (const override of [{ prefix: "/" }, { prefix: "/opt/" }, { dataDirectory: "/var" }, { dataDirectory: "/opt/zelavis/data" }, { prefix: "/var/lib/zelavis-worker/x" }, { commandPath: "/usr/local/bin/other" }]) {
    await assert.rejects(() => planZelavisWorkerInstall({ host: new FakeHost(), source: "/stage", paths: { ...paths, ...override } }), JSON.stringify(override));
  }
});

// --- removal ---

test("the removal plan stops, disables and removes the worker's units, links, account, data and prefix, in a safe order", async () => {
  const receipt = { schemaVersion: 3, role: "worker", version: "1.0.0", installedBy: "cli", prefix: paths.prefix, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, account: WORKER_ACCOUNT, ownsUser: true, ownsGroup: true };
  const plan = planZelavisWorkerUninstall({ paths, receipt, hostCommands: true });
  const order = ids(plan);
  assert.ok(order.indexOf("stop") < order.indexOf("disable"));
  assert.ok(order.indexOf("disable") < order.indexOf("account"));
  assert.ok(order.indexOf("account") < order.indexOf(`remove:${paths.dataDirectory}`), "the account's home is checked before the data is deleted");
  assert.equal(order.at(-1), `remove:${paths.prefix}`, "the receipt and lock go last");
  const removed = plan.steps.filter((step) => step.action.kind === "remove").map((step) => step.action.path);
  for (const name of WORKER_UNITS) assert.ok(removed.includes(`/etc/systemd/system/${name}`));
  assert.ok(removed.includes("/etc/systemd/system/multi-user.target.wants/zelavis-worker.path"));
  assert.ok(!removed.some((path) => /zelavis(\.service|\.socket|-agent|-traefik|-host-agent|-update)/.test(path)), "no Platform unit is removed");
  assert.deepEqual(plan.steps.find((s) => s.id === "account").action, { kind: "remove-account", account: WORKER_ACCOUNT, dataDirectory: paths.dataDirectory, ownsUser: true, ownsGroup: true });
  assert.ok(plan.retained.some((line) => /zelavis nodes remove/.test(line)), "the Platform's record of the node is reported, not silently left");
});

test("without host commands the plan runs none, and account ownership is passed through as recorded", async () => {
  const receipt = { schemaVersion: 3, role: "worker", version: "1.0.0", installedBy: "cli", prefix: paths.prefix, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, account: WORKER_ACCOUNT, ownsUser: false, ownsGroup: false };
  const plan = planZelavisWorkerUninstall({ paths, receipt, hostCommands: false });
  assert.ok(!plan.steps.some((step) => step.action.kind === "command" || step.action.kind === "remove-account"));
  const withAccount = planZelavisWorkerUninstall({ paths, receipt, hostCommands: true });
  assert.deepEqual([withAccount.steps.find((s) => s.id === "account").action.ownsUser, withAccount.steps.find((s) => s.id === "account").action.ownsGroup], [false, false]);
});

async function removalFixture(t, { extra } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-worker-uninstall-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolated = {
    prefix: join(root, "opt"), dataDirectory: join(root, "var-lib-worker"), commandPath: join(root, "bin/zelavis"), systemCommandPath: join(root, "usr/bin/zelavis"),
    systemdDirectories: [join(root, "etc-systemd"), join(root, "lib-systemd"), join(root, "usr-systemd")],
  };
  for (const directory of [isolated.prefix, isolated.dataDirectory, dirname(isolated.commandPath), ...isolated.systemdDirectories]) await mkdir(directory, { recursive: true });
  await writeFile(installationReceiptPath(isolated.prefix), JSON.stringify({
    schemaVersion: 3, role: "worker", version: "1.0.0", installedBy: "cli", prefix: isolated.prefix, dataDirectory: isolated.dataDirectory,
    commandPath: isolated.commandPath, account: WORKER_ACCOUNT, ownsUser: true, ownsGroup: true, ...extra,
  }));
  await mkdir(join(isolated.dataDirectory, "worker"), { recursive: true });
  await writeFile(join(isolated.dataDirectory, "worker/agent.key"), "KEY");
  for (const name of WORKER_UNITS) await writeFile(join(isolated.systemdDirectories[0], name), "unit");
  await symlink(`${isolated.prefix}/current/bin/zelavis`, isolated.commandPath);
  return { root, paths: isolated, installation: { kind: "packaged", root: isolated.prefix, path: `${isolated.prefix}/current/platform/dist/cli.js` }, skipHostCommands: true };
}
const exists = (path) => access(path).then(() => true, () => false);

test("complete removal needs the exact acknowledgement, then removes exactly the worker's inventory", async (t) => {
  const options = await removalFixture(t);
  const bystander = join(options.root, "bystander");
  await writeFile(bystander, "mine");
  const uninstaller = createNodeInstallationUninstaller(options);
  const plan = await uninstaller.plan();
  assert.equal(plan.targets.find((target) => target.id === "data").exists, true);
  assert.equal(new Set(plan.targets.map((target) => target.id)).size, plan.targets.length);
  await assert.rejects(() => uninstaller.uninstall({ confirmation: "yes" }), /DELETE-ALL-ZELAVIS-DATA/);
  assert.ok(await exists(options.paths.dataDirectory), "nothing happened without the acknowledgement");

  const result = await uninstaller.uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  assert.equal(result.removed, true);
  for (const gone of [options.paths.prefix, options.paths.dataDirectory, options.paths.commandPath, join(options.paths.systemdDirectories[0], "zelavis-worker.service"), join(options.paths.systemdDirectories[0], "zelavis-worker.path")]) {
    assert.ok(!(await exists(gone)) && !(await lstat(gone).then(() => true, () => false)), gone);
  }
  assert.equal(await readFile(bystander, "utf8"), "mine", "nothing outside the inventory was touched");
});

test("a command link that is not the worker's own is left alone", async (t) => {
  const options = await removalFixture(t);
  await rm(options.paths.commandPath);
  await symlink("/usr/lib/node_modules/zelavis/bin/zelavis", options.paths.commandPath);
  await createNodeInstallationUninstaller(options).uninstall({ confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION });
  assert.equal(await readlink(options.paths.commandPath), "/usr/lib/node_modules/zelavis/bin/zelavis");
});

test("one receipt, two roles: each reader refuses the other's, and removal is chosen by the role recorded", async (t) => {
  // A worker receipt is never read as a Platform's.
  const host = new FakeHost();
  await executeZelavisInstallationPlan(host, await install(host));
  await assert.rejects(() => readNativeInstallationReceipt(host, paths.prefix), /machine is a Zelavis worker, not a Platform/);
  assert.equal(await readInstallationRole(host, paths.prefix), "worker");

  // And a Platform's is never read as a worker's.
  const platform = new FakeHost();
  platform.files.set(installationReceiptPath(paths.prefix), JSON.stringify({ schemaVersion: 3, role: "platform" }));
  assert.equal(await readInstallationRole(platform, paths.prefix), "platform");
  await assert.rejects(() => readWorkerReceipt(platform, paths.prefix), /Platform is installed here/);

  // Removal plans the worker inventory for a worker receipt: no Edge, no Platform units, no instances.
  const options = await removalFixture(t);
  const plan = await createNodeInstallationUninstaller(options).plan();
  assert.ok(plan.targets.some((target) => target.path === options.paths.dataDirectory && target.id === "data"));
  assert.ok(!plan.targets.some((target) => /edge|traefik|host-agent|zelavis-agent|update|\.socket/i.test(`${target.id} ${target.path ?? ""}`)));
  const none = await removalFixture(t);
  await rm(installationReceiptPath(none.paths.prefix));
  await assert.rejects(() => createNodeInstallationUninstaller(none).plan(), /requires a current installer receipt/);

  const outside = await removalFixture(t);
  assert.throws(() => createNodeInstallationUninstaller({ ...outside, installation: { ...outside.installation, path: "/outside/cli.js" } }), /outside the packaged/);
  assert.throws(() => createNodeInstallationUninstaller({ ...outside, installation: { kind: "npm", path: "/x/cli.js" } }), /packaged/);
  assert.throws(() => createNodeInstallationUninstaller({ ...outside, installation: { ...outside.installation, root: "/" } }), /unsafe installation root/);
});

test("a receipt that names another prefix or account is refused, not trusted", async (t) => {
  const wrongPrefix = await removalFixture(t, { extra: { prefix: "/somewhere/else" } });
  await assert.rejects(() => createNodeInstallationUninstaller(wrongPrefix).plan(), /malformed/);
  const wrongAccount = await removalFixture(t, { extra: { account: "root" } });
  await assert.rejects(() => createNodeInstallationUninstaller(wrongAccount).plan(), /malformed/);
  const wrongData = await removalFixture(t, { extra: { dataDirectory: "/var" } });
  await assert.rejects(() => createNodeInstallationUninstaller(wrongData).plan(), /unsafe/);
});

// --- the CLI ---

test("the CLI refuses Platform-only flags for a worker, by name", async () => {
  for (const flag of [["--user"], ["--instance", "b"], ["--port", "3100"], ["--public"], ["--live"]]) {
    await assert.rejects(() => runReleaseInstall(["--role", "worker", "--from-release", "/stage", "--dry-run", ...flag]), new RegExp(`${flag[0]} only applies to a Platform`));
  }
  await assert.rejects(() => runReleaseInstall(["--role", "worker", "--dry-run"]), /requires --from-release/);
  await assert.rejects(() => runReleaseInstall(["--role", "gateway", "--dry-run"]), /--role must be platform or worker/);
});

test("a worker dry run from a staged release prints its plan and changes nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-worker-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  await mkdir(join(stage, "share"), { recursive: true });
  await writeFile(join(stage, "manifest.json"), JSON.stringify({ version: "1.2.3" }));
  for (const name of WORKER_UNITS) await writeFile(join(stage, "share", name), TEMPLATES[name]);
  const environment = { ZELAVIS_PREFIX: join(root, "opt"), ZELAVIS_DATA_DIR: join(root, "data"), ZELAVIS_BIN_DIR: join(root, "bin"), ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR: join(root, "systemd") };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const realLog = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await runReleaseInstall(["--role", "worker", "--from-release", stage, "--dry-run", "--json"]);
  } finally {
    console.log = realLog;
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
  const plan = JSON.parse(lines.join("\n"));
  assert.equal(plan.operation, "install");
  assert.equal(plan.dataDirectory, join(root, "data-worker"));
  assert.ok(plan.steps.some((step) => step.id === "zelavis-worker.service"));
  assert.ok(!(await exists(join(root, "opt"))) && !(await exists(join(root, "data-worker"))), "a dry run changed nothing");
});
