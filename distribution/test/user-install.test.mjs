import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freePort, stageCli } from "./staged-cli.mjs";

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "zelavis user install ")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, "stage");
  await mkdir(join(source, "runtime/node/bin"), { recursive: true });
  await mkdir(join(source, "bin"), { recursive: true });
  await writeFile(join(source, "manifest.json"), JSON.stringify({ name: "zelavis", version: "2.0.0-alpha.5" }));
  // Fake private runtime uses the test runner only; production acquisition
  // refuses symlinks and obtains the real binary from the verified archive.
  await symlink(process.execPath, join(source, "runtime/node/bin/node"));
  await copyFile(new URL("../runtime/zelavis", import.meta.url), join(source, "bin/zelavis"));
  await stageCli(source);
  const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home };
  const run = (args) => spawnSync(process.execPath, [join(source, "platform/dist/cli.js"), ...args], { encoding: "utf8", env });
  const prefix = join(home, ".local/share/zelavis");
  return { source, home, prefix, env, run, port: String(await freePort()), command: join(home, ".local/bin/zelavis") };
}

test("user CLI install, repair and destructive uninstall stay within the user inventory", async (t) => {
  const f = await fixture(t);
  const dry = f.run(["install", "--from-release", f.source, "--port", f.port, "--user", "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  await assert.rejects(stat(f.prefix), { code: "ENOENT" });
  const first = f.run(["install", "--from-release", f.source, "--port", f.port, "--user"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /First-run bootstrap token/);
  const environment = join(f.prefix, "config/zelavis.env");
  const before = await readFile(environment, "utf8");
  assert.match(before, /ZELAVIS_DATA_DIR=/);
  assert.equal((await stat(environment)).mode & 0o777, 0o600);
  const second = f.run(["install", "--from-release", f.source, "--port", f.port, "--user"]);
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /First-run bootstrap token/);
  assert.equal(await readFile(environment, "utf8"), before);
  const version = spawnSync(f.command, ["--version"], { env: f.env, cwd: "/", encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /packaged installation/);
  const plan = spawnSync(f.command, ["uninstall", "--all", "--dry-run", "--json"], { env: f.env, encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.doesNotMatch(plan.stdout, /\/etc\/systemd|\/etc\/apt|\/usr\/bin\/zelavis/);
  const removed = spawnSync(f.command, ["uninstall", "--all", "--confirm", "DELETE-ALL-ZELAVIS-DATA"], { env: f.env, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(stat(f.prefix), { code: "ENOENT" });
  await assert.rejects(stat(f.command), { code: "ENOENT" });
  await stat(f.source);
});

test("launcher loads user data/token from any cwd and never falls back to host Node", async (t) => {
  const f = await fixture(t);
  const installed = f.run(["install", "--from-release", f.source, "--port", f.port, "--user"]);
  assert.equal(installed.status, 0, installed.stderr);
  const release = join(f.prefix, "releases/2.0.0-alpha.5");
  await writeFile(join(release, "platform/dist/cli.js"), 'console.log(JSON.stringify({data:process.env.ZELAVIS_DATA_DIR,token:!!process.env.ZELAVIS_BOOTSTRAP_TOKEN,host:process.env.HOST}));');
  const result = spawnSync(f.command, [], { env: f.env, cwd: "/", encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { data: join(f.prefix, "data"), token: true, host: "127.0.0.1" });
  await rm(join(release, "runtime/node/bin/node"));
  const missing = spawnSync(f.command, [], { env: f.env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /private Node runtime is missing/);
});


test("staged user doctor is read-only, returns JSON and reports missing receipts without creating state", async (t) => {
  const f = await fixture(t);
  const absent = f.run(["doctor", "--user", "--json"]);
  assert.equal(absent.status, 1, absent.stderr);
  assert.equal(JSON.parse(absent.stdout).healthy, false);
  await assert.rejects(stat(f.prefix), { code: "ENOENT" });
  assert.equal(f.run(["install", "--from-release", f.source, "--port", f.port, "--user"]).status, 0);
  const receipt = await readFile(join(f.prefix, "installation.json"), "utf8");
  const env = await readFile(join(f.prefix, "config/zelavis.env"), "utf8");
  const snapshot = () => Promise.all([f.prefix, join(f.prefix, "data"), join(f.prefix, "config")].map((directory) => readdir(directory)));
  const inventory = await snapshot();
  const report = spawnSync(f.command, ["doctor", "--json"], { env: { ...f.env, PATH: `${f.home}/.local/bin:${f.env.PATH}` }, encoding: "utf8" });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).healthy, true, report.stdout);
  assert.doesNotMatch(report.stdout, /ZELAVIS_BOOTSTRAP_TOKEN|session.*secret/);
  assert.equal(await readFile(join(f.prefix, "installation.json"), "utf8"), receipt);
  assert.equal(await readFile(join(f.prefix, "config/zelavis.env"), "utf8"), env);
  assert.deepEqual(await snapshot(), inventory);
});
