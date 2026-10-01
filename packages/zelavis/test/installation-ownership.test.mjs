import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { acquireLocalDataOwnership, acquireNodeInstallerLock } from "../dist/adapters/_local-ownership.js";
import { createNodeInstallHost } from "../dist/adapters/_install-host.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { Zelavis } from "../dist/index.js";

const module = new URL("../dist/adapters/_local-ownership.js", import.meta.url).href;
async function root(t) { const path = await mkdtemp(join(tmpdir(), "zelavis-ownership-")); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function holder(t, method, path) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {${method}} from ${JSON.stringify(module)}; await ${method}(${JSON.stringify(path)}); console.log("ready"); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
  return { child, exited, ready: new Promise((resolve, reject) => { let errors = ""; child.stderr.on("data", (chunk) => errors += chunk); child.stdout.once("data", resolve); child.once("exit", () => reject(new Error(errors || "holder exited before acquisition"))); child.once("error", reject); }) };
}

for (const method of ["acquireNodeInstallerLock", "acquireLocalDataOwnership"]) test(`${method} excludes a competing process and recovers after SIGKILL`, async (t) => {
  const path = await root(t);
  const child = holder(t, method, path);
  await child.ready;
  const acquire = method === "acquireNodeInstallerLock" ? acquireNodeInstallerLock : acquireLocalDataOwnership;
  await assert.rejects(acquire(path), /busy|already reserved/);
  child.child.kill("SIGKILL"); await child.exited;
  let lease;
  for (let attempt = 0; attempt < 100 && !lease; attempt++) { try { lease = await acquire(path); } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  assert.ok(lease, "kernel must release a crashed process reservation");
  await lease.release();
});

test("concurrent installer reservations in one process have exactly one winner", async (t) => {
  const path = await root(t);
  const attempts = await Promise.allSettled([acquireNodeInstallerLock(path), acquireNodeInstallerLock(path)]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of attempts) if (result.status === "fulfilled") await result.value.release();
});

test("live data ownership is inspected without mutation and normal release clears the owner", async (t) => {
  const path = await root(t);
  const lease = await acquireLocalDataOwnership(path);
  const before = await readFile(join(path, ".platform-owner.json"), "utf8");
  assert.equal((await createNodeInstallHost().dataOwnership(path)).active, true);
  assert.equal(await readFile(join(path, ".platform-owner.json"), "utf8"), before);
  await lease.release();
  assert.deepEqual(await createNodeInstallHost().dataOwnership(path), { active: false });
});

test("symlinked lock files are refused", async (t) => {
  const path = await root(t);
  await symlink("/outside/lock", join(path, ".install.lock"));
  await assert.rejects(acquireNodeInstallerLock(path), /symlinked installer lock/);
});

test("Node Platforms cannot share data, including through a reused adapter; close permits a new owner", async (t) => {
  const path = await root(t);
  const adapter = nodeAdapter({ dataDirectory: path, services: false, projects: false });
  const first = new Zelavis({ adapter });
  const reused = new Zelavis({ adapter });
  const second = new Zelavis({ adapter: nodeAdapter({ dataDirectory: path, services: false, projects: false }) });
  t.after(() => Promise.all([first.close(), reused.close(), second.close()]));
  await first.runtime();
  await assert.rejects(reused.runtime(), /already owns a Platform/);
  await assert.rejects(second.runtime(), /already reserved/);
  assert.equal((await createNodeInstallHost().dataOwnership(path)).active, true);
  await first.close();
  const third = new Zelavis({ adapter: nodeAdapter({ dataDirectory: path, services: false, projects: false }) });
  t.after(() => third.close());
  await third.runtime();
  await third.close();
});

test("failed initial Platform construction releases adapter ownership", async (t) => {
  const path = await root(t);
  const adapter = nodeAdapter({ dataDirectory: path, services: false, projects: false });
  const broken = new Zelavis({ adapter: { ...adapter, async resolve(options) { await adapter.resolve(options); throw new Error("failed initial composition"); } } });
  await assert.rejects(broken.runtime(), /failed initial composition/);
  assert.deepEqual(await createNodeInstallHost().dataOwnership(path), { active: false });
  const repaired = new Zelavis({ adapter: nodeAdapter({ dataDirectory: path, services: false, projects: false }) });
  t.after(() => repaired.close());
  await repaired.runtime();
  await repaired.close();
});


test("read-only socket probes correlate occupied ports with the actual listener PID", async (t) => {
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const host = createNodeInstallHost();
  assert.equal(await host.portAvailable(port), false);
  assert.equal(await host.portOwnedBy(process.pid, port), true);
  assert.equal(await host.portOwnedBy(2147483647, port), false);
});
