import assert from "node:assert/strict";
import test from "node:test";
import { inspectZelavisInstallation, preflightZelavisInstall } from "../dist/core/runtime/installation-health.js";

const paths = { prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis", configDirectory: "/etc/zelavis", commandPath: "/usr/local/bin/zelavis", systemCommandPath: "/usr/bin/zelavis", systemdDirectories: ["/etc/systemd/system", "/lib/systemd/system"] };
const receipt = { schemaVersion: 2, port: 3000, edge: true, mode: "system", source: "package", instance: "default", installedBy: "create", version: "1.2.3", prefix: paths.prefix, configDirectory: paths.configDirectory, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, ownsUser: true, ownsGroup: true };
const installation = { kind: "packaged", path: "/opt/zelavis/current/platform/dist/cli.js", root: paths.prefix };
class Probe {
  files = new Map([["/opt/zelavis/installation.json", JSON.stringify(receipt)], ["/opt/zelavis/current/manifest.json", '{"version":"1.2.3"}'], ["/etc/systemd/system/zelavis.service", "ExecStart=/opt/zelavis/current/bin/zelavis\nEnvironment=ZELAVIS_DATA_DIR=/var/lib/zelavis"]]);
  links = new Map([[paths.commandPath, "/opt/zelavis/current/bin/zelavis"], ["/opt/zelavis/current", "releases/1.2.3"]]);
  owner = { active: false }; command = paths.commandPath; busy = new Set(); matchesPort = false; uid = { uid: 10, expectedUid: 10 };
  units = { present: true, active: true, enabled: true, pid: 42, delegates: true }; support = { cgroupV2: true, cgroupKill: true };
  constructor() { this.files.set("/opt/zelavis/.edge-owner.lock", ""); this.files.set("/opt/zelavis/runtime.json", JSON.stringify({schemaVersion: 1, prefix: paths.prefix, instance: "default", dataDirectory: paths.dataDirectory, configDirectory: paths.configDirectory, port: 3000, host: "127.0.0.1", edge: true})); this.files.set("/opt/zelavis/edge-owner.json", JSON.stringify({schemaVersion: 1, prefix: paths.prefix, instance: "default", dataDirectory: paths.dataDirectory})); for (const name of ["zelavis-agent.service", "zelavis-traefik.service", "zelavis-host-agent.service"]) this.files.set(`/etc/systemd/system/${name}`, this.files.get("/etc/systemd/system/zelavis.service")); }
  reads = []; mutations = [];
  async read(path) { this.reads.push(path); return this.files.get(path); }
  async exists(path) { return path.endsWith("runtime/node/bin/node") || this.files.has(path); }
  async readlink(path) { return this.links.get(path); }
  async which() { return this.command; }
  async dataOwnership() { return this.owner; }
  async portAvailable(port) { return !this.busy.has(port); }
  async portOwnedBy() { return this.matchesPort; }
  socketUnit = { present: false, active: false, enabled: false };
  async unitState(name) { return name.endsWith(".socket") ? this.socketUnit : this.units; }
  async dataOwner() { return this.uid; }
  async agentSupport() { return this.support; }
  async execute(action) { this.mutations.push(action); throw new Error("inspection must never mutate"); }
}
const preflight = (host, options = {}) => preflightZelavisInstall({ host, paths, system: true, ...options });
const doctor = (host) => inspectZelavisInstallation({ host, paths, installation });

test("same receipt permits repair; foreign PATH needs force, and another prefix cannot be forced", async () => {
  const host = new Probe();
  assert.deepEqual(await preflight(host), { stopPlatform: true });
  for (const command of ["/npm/bin/zelavis", "/source/node_modules/.bin/zelavis", "/foreign/bin/zelavis"]) {
    host.command = command;
    await assert.rejects(preflight(host), /originating lifecycle.*npm uninstall/s);
    await preflight(host, { force: true });
  }
  host.files.set("/home/operator/.local/share/zelavis/installation.json", "another receipt");
  await assert.rejects(preflight(host, { force: true, otherPrefixes: ["/home/operator/.local/share/zelavis"] }), /Another Zelavis installation/);
  assert.equal(host.mutations.length, 0);
});

test("receipt layout and mode disagreement and pre-phase receipts are refused", async () => {
  for (const changes of [{ dataDirectory: "/var/lib/other" }, { configDirectory: "/etc/other" }, { mode: "user" }, { prefix: "/opt/other" }, { instance: "secondary" }]) {
    const host = new Probe(); host.files.set("/opt/zelavis/installation.json", JSON.stringify({ ...receipt, ...changes }));
    await assert.rejects(preflight(host), /receipt|Receipt/);
  }
  const host = new Probe(); host.files.set("/opt/zelavis/installation.json", '{"schemaVersion":1,"dataDirectory":"/var/lib/zelavis"}');
  await assert.rejects(preflight(host), /receipt/);
});

test("maintenance stops only its own service, with matching live data and listener identity", async () => {
  const host = new Probe();
  host.owner = { active: true, pid: 42, installationRoot: paths.prefix, purpose: "platform" };
  host.busy.add(3000); host.matchesPort = true;
  assert.deepEqual(await preflight(host), { stopPlatform: true });
  host.matchesPort = false;
  await assert.rejects(preflight(host, { force: true }), /Port 3000/);
  host.busy.clear(); host.owner = { ...host.owner, pid: 99 };
  await assert.rejects(preflight(host, { force: true }), /owned by running PID 99/);
  host.owner = { ...host.owner, pid: 42, purpose: "maintenance" };
  await assert.rejects(preflight(host, { force: true }), /data ownership/);
  host.owner = { ...host.owner, purpose: "platform", installationRoot: "/foreign" };
  await assert.rejects(preflight(host, { force: true }), /data ownership/);
  assert.equal(host.mutations.length, 0);
});

test("a port held by this installation's own socket is not a conflict, and doctor says so", async () => {
  const host = new Probe();
  host.busy.add(3000); host.socketUnit = { present: true, active: true, enabled: true };
  assert.deepEqual(await preflight(host), { stopPlatform: true });
  const report = await doctor(host);
  assert.equal(report.checks.find((item) => item.id === "port:3000").status, "ok");
  assert.match(report.checks.find((item) => item.id === "port:3000").detail, /held by systemd/);
  assert.equal(report.checks.find((item) => item.id === "socket").status, "ok");
  host.socketUnit = { present: false, active: false, enabled: false };
  assert.equal((await doctor(host)).checks.find((item) => item.id === "socket").status, "warning");
});

test("a live swap leaves the running Platform and its own lock alone", async () => {
  const host = new Probe();
  host.owner = { active: true, pid: 42, installationRoot: paths.prefix, purpose: "platform" };
  host.busy.add(3000); host.matchesPort = true;
  assert.deepEqual(await preflight(host, { live: true }), { stopPlatform: false });
});

test("user Platforms must stop before maintenance and units with competing layouts are refused", async () => {
  const host = new Probe(); host.files.set("/opt/zelavis/installation.json", JSON.stringify({ ...receipt, mode: "user", edge: false }));
  host.owner = { active: true, pid: 42, installationRoot: paths.prefix, purpose: "platform" };
  await assert.rejects(preflight(host, { system: false, user: true, force: true }), /Stop that Platform/);
  host.files.set("/opt/zelavis/installation.json", JSON.stringify(receipt)); host.owner = { active: false };
  host.files.set("/lib/systemd/system/zelavis.service", "ExecStart=/foreign/zelavis");
  await assert.rejects(preflight(host, { force: true }), /different layout/);
});

test("doctor reports healthy receipt/release/service state without touching configuration or secrets", async () => {
  const host = new Probe(); const before = JSON.stringify([...host.files]);
  host.busy.add(80); host.busy.add(443);
  const report = await doctor(host);
  assert.equal(report.healthy, true, JSON.stringify(report));
  assert.ok(report.checks.some((check) => check.id === "port:443" && /occupied/.test(check.detail)));
  assert.equal(JSON.stringify([...host.files]), before);
  assert.equal(host.mutations.length, 0);
  assert.ok(!host.reads.some((path) => path.endsWith("zelavis.env")));
  assert.ok(!report.checks.some((check) => /kvm/i.test(check.id)));
});

test("doctor correlates live port ownership and reports release, data, PATH and Agent problems", async () => {
  const host = new Probe(); host.command = "/npm/bin/zelavis";
  host.owner = { active: true, pid: 42, installationRoot: paths.prefix, purpose: "platform" };
  host.busy.add(3000); host.matchesPort = true;
  assert.equal((await doctor(host)).checks.find((item) => item.id === "port:3000").status, "ok");
  host.matchesPort = false; host.uid = { uid: 11, expectedUid: 10 }; host.support = { cgroupV2: false, cgroupKill: false };
  host.links.set("/opt/zelavis/current", "releases/9.0.0");
  const report = await doctor(host);
  assert.equal(report.healthy, false);
  for (const id of ["release", "data", "port:3000"]) assert.equal(report.checks.find((item) => item.id === id).status, "error");
  for (const id of ["path", "agent"]) assert.equal(report.checks.find((item) => item.id === id).status, "warning");
});

test("doctor continues after corrupt receipt or inaccessible probes and never acquires a lock", async () => {
  const host = new Probe(); host.files.set("/opt/zelavis/installation.json", "broken JSON"); host.dataOwnership = async () => { throw new Error("permission denied"); };
  const report = await doctor(host);
  assert.equal(report.healthy, false);
  assert.equal(report.checks.find((item) => item.id === "receipt").status, "error");
  assert.match(report.checks.find((item) => item.id === "data").detail, /permission denied/);
  assert.equal(host.mutations.length, 0);
});

test("preflight inspects the command answering now even when the future command directory precedes it", async () => {
  const host = new Probe();
  host.which = async (_command, planned) => planned ?? "/source/node_modules/.bin/zelavis";
  await assert.rejects(preflight(host), /Another Zelavis installation answers on PATH/);
  assert.equal(host.mutations.length, 0);
});


test("named preflight allows the shared prefix but refuses missing/reserved ports and foreign units", async () => {
  const host = new Probe(); host.units = { present: true, active: false, enabled: false };
  host.listInstances = async (prefix) => prefix === paths.prefix ? ["default"] : [];
  const named = { ...paths, instance: "preview", dataDirectory: "/var/lib/zelavis-preview", configDirectory: "/etc/zelavis-preview" };
  const input = { host, paths: named, system: true };
  await assert.rejects(preflightZelavisInstall(input), /reserved by instance default|explicit --port/);
  await assert.rejects(preflightZelavisInstall({ ...input, port: 3000, force: true }), /reserved by instance default/);
  assert.deepEqual(await preflightZelavisInstall({ ...input, port: 3100 }), { stopPlatform: false });
  host.busy.add(3100);
  await assert.rejects(preflightZelavisInstall({ ...input, port: 3100, force: true }), /Port 3100/);
  host.busy.clear();
  host.files.set("/etc/systemd/system/zelavis@.service", "ExecStart=/foreign/current/bin/zelavis");
  await assert.rejects(preflightZelavisInstall({ ...input, port: 3100 }), /different layout/);
  assert.equal(host.mutations.length, 0);
});
test("named doctor inspects its own receipt/release/port and expanded templates without mutations", async () => {
  const host = new Probe();
  const named = { ...paths, instance: "preview", dataDirectory: "/var/lib/zelavis-preview", configDirectory: "/etc/zelavis-preview" };
  const scope = "/opt/zelavis/instances/preview";
  host.files.set(`${scope}/runtime.json`, JSON.stringify({schemaVersion: 1, prefix: paths.prefix, instance: "preview", dataDirectory: named.dataDirectory, configDirectory: named.configDirectory, port: 3100, host: "127.0.0.1", edge: false}));
  host.files.set(`${scope}/installation.json`, JSON.stringify({ ...receipt, ...named, instance: "preview", port: 3100, edge: false }));
  host.files.set(`${scope}/current/manifest.json`, '{"version":"1.2.3"}');
  host.links.set(`${scope}/current`, "/opt/zelavis/releases/1.2.3");
  for (const unit of ["zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent@.service"]) host.files.set(`/etc/systemd/system/${unit}`, "ExecStart=/opt/zelavis/instances/%i/current/bin/zelavis\nEnvironment=ZELAVIS_DATA_DIR=/var/lib/zelavis-%i");
  const report = await inspectZelavisInstallation({ host, paths: named, installation });
  assert.equal(report.healthy, true, JSON.stringify(report));
  assert.ok(report.checks.some((item) => item.id === "port:3100"));
  assert.ok(!report.checks.some((item) => item.id === "unit:zelavis.service" || item.id.includes("traefik")));
  assert.match(report.checks.find((item) => item.id === "edge-owner").detail, /Edge off/);
  assert.equal(host.mutations.length, 0);
});
test("a foreign host Edge owner blocks default repair before any changes", async () => {
  const host = new Probe(); host.files.set("/opt/zelavis/edge-owner.json", JSON.stringify({schemaVersion: 1, prefix: paths.prefix, instance: "foreign", dataDirectory: "/elsewhere/data"}));
  await assert.rejects(preflight(host, { force: true }), /Host Edge belongs/);
  assert.equal(host.mutations.length, 0);
});
