import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readNodeInstallationRuntime } from "../dist/adapters/_installation-runtime.js";
import { runCli } from "../dist/cli/index.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zelavis-instance-runtime-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const prefix = join(root, "installation");
  const scope = join(prefix, "instances/preview");
  await mkdir(scope, {recursive: true});
  const descriptor = {schemaVersion: 1, prefix, instance: "preview", dataDirectory: join(root, "data-preview"), configDirectory: join(root, "config-preview"), port: 3100, host: "127.0.0.1", edge: false};
  await writeFile(join(scope, "runtime.json"), JSON.stringify(descriptor), {mode: 0o644});
  return {root, prefix, scope, descriptor};
}
test("runtime selection is secret-free and refuses malformed inventory or secondary Edge authority", async (t) => {
  const f = await fixture(t);
  const selected = await readNodeInstallationRuntime(f.prefix, "preview");
  assert.equal(selected.port, 3100); assert.equal(selected.dataDirectory, f.descriptor.dataDirectory);
  assert.equal(selected.node, `${f.scope}/current/runtime/node/bin/node`);
  for (const patch of [{edge: true}, {instance: "default"}, {prefix: "/elsewhere"}, {port: 80}, {dataDirectory: "/"}]) {
    await writeFile(`${f.scope}/runtime.json`, JSON.stringify({...f.descriptor, ...patch}));
    await assert.rejects(readNodeInstallationRuntime(f.prefix, "preview"), /Malformed|port must|unsafe/);
  }
  assert.equal(await readNodeInstallationRuntime(undefined), undefined);
});
test("CLI forwards instance selection only to local lifecycle commands", async () => {
  const calls = [];
  await runCli(["serve", "--instance", "preview"], {runtime: {serve: async (value) => calls.push(value)}});
  assert.equal(calls[0].instance, "preview"); assert.equal(calls[0].portExplicit, false);
  assert.equal(calls[0].dataExplicit, false);
  const original = console.log; console.log = () => {};
  try {
    await runCli(["uninstall", "--instance", "preview", "--all", "--dry-run"], {runtime: {serve: async () => {}, createInstallationUninstaller: async (options) => { calls.push(options); return {plan: async () => ({adapter: "node", installation: {}, dataDirectory: "/data-preview", targets: [], retained: []})}; }}});
  } finally {console.log = original;}
  assert.equal(calls[1].instance, "preview");
  const error = console.error, exit = process.exitCode; const errors = []; console.error = (value) => errors.push(value);
  try { await runCli(["serve", "--instance", "../escape"], {runtime: {serve: async () => {}}}); assert.equal(process.exitCode, 1); assert.match(errors.join("\n"), /Instance names/); }
  finally {console.error = error; process.exitCode = exit;}
});
test("shared management CLI re-executes the selected immutable release and serves its own System Store", async (t) => {
  const f = await fixture(t);
  const server = createServer();
  await new Promise((resolve, reject) => {server.once("error", reject); server.listen(0, "127.0.0.1", resolve);});
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await writeFile(`${f.scope}/runtime.json`, JSON.stringify({...f.descriptor, port}));
  const pkg = fileURLToPath(new URL("../", import.meta.url));
  for (const version of ["1.0.0", "2.0.0"]) {
    const release = `${f.prefix}/releases/${version}`;
    await mkdir(`${release}/platform`, {recursive: true});
    await cp(`${pkg}/dist`, `${release}/platform/dist`, {recursive: true});
    await writeFile(`${release}/platform/package.json`, JSON.stringify({...JSON.parse(await readFile(`${pkg}/package.json`, "utf8")), version}));
    await cp(`${pkg}/services`, `${release}/platform/services`, {recursive: true});
    await mkdir(`${release}/platform/node_modules`);
    for (const dependency of await readdir(`${pkg}/node_modules`)) {
      if (dependency.startsWith(".") || ["@zelavis", "zelavis"].includes(dependency)) continue;
      await symlink(`${pkg}/node_modules/${dependency}`, `${release}/platform/node_modules/${dependency}`);
    }
    await mkdir(`${release}/runtime/node/bin`, {recursive: true});
    // The test process stands in for the private, already verified Node.
    await symlink(process.execPath, `${release}/runtime/node/bin/node`);
  }
  await symlink(`${f.prefix}/releases/1.0.0`, `${f.prefix}/current`);
  await symlink(`${f.prefix}/releases/2.0.0`, `${f.scope}/current`);
  const child = spawn(process.execPath, [`${f.prefix}/current/platform/dist/cli.js`, "serve", "--instance", "preview"], {stdio: ["ignore", "pipe", "pipe"], env: {...process.env, ZELAVIS_BOOTSTRAP_TOKEN: "a".repeat(64), ZELAVIS_AGENT_ENDPOINT: ""}});
  let output = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => output += chunk);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {if (child.exitCode === null) child.kill("SIGTERM"); await exited;});
  let status;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { const response = await fetch(`http://127.0.0.1:${port}/zelavis/api/v1/auth/bootstrap`, {signal: AbortSignal.timeout(500)}); if (response.ok) {status = await response.json(); break;} } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(status, output);
  const owner = JSON.parse(await readFile(`${f.descriptor.dataDirectory}/.platform-owner.json`, "utf8"));
  assert.equal(owner.installationRoot, f.prefix);
  assert.notEqual(owner.pid, child.pid, "management CLI must launch the selected release as its child");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, output);
  await assert.rejects(readFile(`${f.descriptor.dataDirectory}/.platform-owner.json`), {code: "ENOENT"});
});


test("shared prefix/release/instance directories and public descriptors survive a restrictive umask", async (t) => {
  const f = await fixture(t);
  const { createNodeInstallHost } = await import("../dist/adapters/_install-host.js");
  const { planZelavisReleaseInstall, executeZelavisInstallationPlan } = await import("../dist/core/runtime/installation-plan.js");
  const source = join(f.root, "source"); await mkdir(source); await writeFile(`${source}/manifest.json`, '{"version":"1.0.0"}');
  const paths = {prefix: f.prefix, instance: "preview", dataDirectory: f.descriptor.dataDirectory, configDirectory: f.descriptor.configDirectory, commandPath: `${f.root}/bin/zelavis`, systemCommandPath: `${f.root}/system-bin/zelavis`, systemdDirectories: [`${f.root}/units`], aptSource: `${f.root}/zelavis.sources`, aptKeyring: `${f.root}/zelavis-archive-keyring.gpg`};
  const host = createNodeInstallHost();
  const mask = process.umask(0o077);
  try {
    await executeZelavisInstallationPlan(host, await planZelavisReleaseInstall({host, source, paths, system: false, port: 3100}));
    for (const path of [f.prefix, `${f.prefix}/releases`, `${f.prefix}/instances`, f.scope]) assert.equal((await stat(path)).mode & 0o777, 0o755, path);
    assert.equal((await stat(f.descriptor.dataDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(`${f.scope}/runtime.json`)).mode & 0o777, 0o644);
    assert.equal((await stat(`${f.scope}/installation.json`)).mode & 0o777, 0o600);
    const { claimLocalEdgeOwner } = await import("../dist/adapters/_local-ownership.js");
    await claimLocalEdgeOwner({prefix: f.prefix, instance: "default", dataDirectory: `${f.root}/default-data`});
    assert.equal((await stat(`${f.prefix}/edge-owner.json`)).mode & 0o777, 0o644);
    assert.equal((await stat(`${f.prefix}/.edge-owner.lock`)).mode & 0o777, 0o660);
    const trust = `${f.root}/trust.json`;
    await host.execute({kind: "write", path: trust, content: "public trust", mode: 0o644, ifAbsent: true});
    assert.equal((await stat(trust)).mode & 0o777, 0o644);
  } finally {process.umask(mask);}
});
