import assert from "node:assert/strict";
import test from "node:test";
import { inspectZelavisWorker } from "../dist/core/runtime/worker-installation-plan.js";

const paths = { prefix: "/opt/zelavis", dataDirectory: "/var/lib/zelavis-worker", configDirectory: "/var/lib/zelavis-worker", commandPath: "/usr/local/bin/zelavis", systemCommandPath: "/usr/bin/zelavis", systemdDirectories: ["/etc/systemd/system"] };
const receipt = { schemaVersion: 3, role: "worker", version: "1.2.3", installedBy: "script", prefix: paths.prefix, dataDirectory: paths.dataDirectory, commandPath: paths.commandPath, account: "zelavis-worker", ownsUser: true, ownsGroup: true };
const installation = { kind: "packaged", path: "/opt/zelavis/current/platform/dist/cli.js", root: paths.prefix };

class Probe {
  files = new Map([["/opt/zelavis/installation.json", JSON.stringify(receipt)], ["/opt/zelavis/current/manifest.json", '{"version":"1.2.3"}']]);
  units = { "zelavis-worker.path": { present: true, enabled: true, active: true }, "zelavis-worker.service": { present: true, enabled: false, active: false } };
  account = true; owner = { uid: 990, expectedUid: 990 }; busy = new Set(); mutations = [];
  async read(path) { return this.files.get(path); }
  async exists(path) { return path.endsWith("runtime/node/bin/node") || this.files.has(path); }
  async accountExists() { return this.account; }
  async dataOwner() { return this.owner; }
  async unitState(name) { return this.units[name]; }
  async portAvailable(port) { return !this.busy.has(port); }
  async execute(action) { this.mutations.push(action); throw new Error("inspection must never mutate"); }
}
const run = (host) => inspectZelavisWorker({ host, paths, installation });
const statusOf = (report, id) => report.checks.find((check) => check.id === id)?.status;

test("a freshly installed worker is healthy but reports that it has not joined", async () => {
  const host = new Probe();
  const report = await run(host);
  assert.equal(report.healthy, true, JSON.stringify(report.checks));
  assert.equal(statusOf(report, "joined"), "warning");
  assert.equal(statusOf(report, "unit:zelavis-worker.path"), "ok");
  assert.equal(statusOf(report, "unit:zelavis-worker.service"), "ok", "the Agent is not expected to run before joining");
  assert.equal(host.mutations.length, 0);
});

test("a joined worker needs its Agent running and listening", async () => {
  const host = new Probe();
  host.files.set("/var/lib/zelavis-worker/worker/remote-project.json", JSON.stringify({ nodeId: "node-a", port: 8443 }));
  let report = await run(host);
  assert.equal(statusOf(report, "unit:zelavis-worker.service"), "error", "joined, but the Agent is not running");
  assert.equal(report.healthy, false);

  host.units["zelavis-worker.service"] = { present: true, enabled: true, active: true };
  host.busy.add(8443);
  report = await run(host);
  assert.equal(report.healthy, true, JSON.stringify(report.checks));
  assert.equal(statusOf(report, "port:8443"), "ok");

  host.busy.delete(8443);
  report = await run(host);
  assert.equal(statusOf(report, "port:8443"), "error", "running but not listening");
});

test("a missing account, wrong data owner, absent unit and mismatched release are each reported", async () => {
  const host = new Probe();
  host.account = false; host.owner = { uid: 0, expectedUid: 990 };
  host.units["zelavis-worker.path"] = { present: false, enabled: false, active: false };
  host.files.set("/opt/zelavis/current/manifest.json", '{"version":"9.9.9"}');
  const report = await run(host);
  for (const id of ["account", "data", "unit:zelavis-worker.path", "release"]) assert.equal(statusOf(report, id), "error", id);
});

test("a Platform's receipt is refused rather than inspected as a worker", async () => {
  const host = new Probe();
  host.files.set("/opt/zelavis/installation.json", JSON.stringify({ ...receipt, role: "platform" }));
  const report = await run(host);
  assert.equal(statusOf(report, "receipt"), "error");
  assert.match(report.checks.find((c) => c.id === "receipt").detail, /Platform is installed/);
});
