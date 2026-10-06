/** Runs only in the disposable Linux/systemd provisioning harness. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1" || process.getuid() !== 0) throw new Error("Disposable root qualification only.");
await readFile("/.dockerenv");
const previous = await realpath("/opt/zelavis/current");
const manifest = JSON.parse(await readFile(join(previous, "manifest.json"), "utf8"));
const previousVersion = manifest.version;
const targetVersion = "2.0.0-alpha.999";
const target = `/opt/zelavis/releases/${targetVersion}`;
await cp(previous, target, { recursive: true, verbatimSymlinks: true });
manifest.version = targetVersion;
await writeFile(join(target, "manifest.json"), JSON.stringify(manifest));
const packageFile = join(target, "platform/package.json");
const packageManifest = JSON.parse(await readFile(packageFile, "utf8"));
packageManifest.version = targetVersion;
await writeFile(packageFile, JSON.stringify(packageManifest));
const recipeFile = join(target, "platform/services/zelavis-app/package.json");
const recipeManifest = JSON.parse(await readFile(recipeFile, "utf8"));
recipeManifest.version = "1.0.1-alpha.999";
await writeFile(recipeFile, JSON.stringify(recipeManifest));
const { Effect } = createRequire(packageFile)("effect");
const { sealNodeRuntimeArtifact } = await import(pathToFileURL(join(target, "platform/dist/adapters/_node-runtime-artifact.js")));
await Effect.runPromise(sealNodeRuntimeArtifact(target));
const { selectNodeInstallationRuntime } = await import(pathToFileURL(join(target, "platform/dist/adapters/_node-runtime-selection.js")));
const { createZelavisClient } = await import(pathToFileURL(join(previous, "platform/dist/sdk/fetch.js")));
const cookie = await readFile("/var/lib/zelavis/qualification-session", "utf8");
const client = createZelavisClient({ baseUrl: "http://127.0.0.1:3000", headers: { cookie, origin: "http://127.0.0.1:3000" } });
const wp = await client.projects.get("qualification-wordpress");
assert.equal(wp.runtime.status, "running");
const app = await client.projects.create({ id: "handover-app", name: "Handover App", start: false });
const frontend = "/var/lib/zelavis/projects/handover-app/.zelavis/services/qualification";
await mkdir(join(frontend, "dist"), { recursive: true });
await writeFile(join(frontend, "package.json"), JSON.stringify({ name: "@qualification/site", version: "1.0.0", zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "dist" } } }));
await writeFile(join(frontend, "dist/index.html"), "<h1>App continuity qualification</h1>");
execFileSync("chown", ["-R", "zelavis:zelavis", join(frontend, "..")]);
const started = await client.projects.start(app.id);
assert.equal(started.runtime.status, "running");
const stateDirectory = "/var/lib/zelavis/projects/.agent-processes";
const identities = async () => (await Promise.all((await readdir(stateDirectory)).map(async name => JSON.parse(await readFile(join(stateDirectory, name), "utf8"))))).map(value => `${value.workloadId}:${value.pid}`).sort();
const before = await identities();
assert.ok(before.some(value => value.startsWith(`${wp.id}:`)));
assert.ok(before.some(value => value.startsWith(`${app.id}:`)));
const urls = [`http://127.0.0.1:${wp.preview.port}/wp-admin/`, `http://127.0.0.1:${started.preview.port}/`];
const platformPid = execFileSync("systemctl", ["show", "zelavis.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim();
for (const version of [targetVersion, previousVersion]) {
  let complete = false;
  const traffic = Promise.all(urls.map(async url => {
    let requests = 0;
    while (!complete || requests < 30) {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      assert.ok([200, 302].includes(response.status), `${url}: ${response.status}`);
      await response.arrayBuffer(); requests++;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }));
  const selected = Effect.runPromise(selectNodeInstallationRuntime({ prefix: "/opt/zelavis", instance: "default", dataDirectory: "/var/lib/zelavis", version })).finally(() => { complete = true; });
  const results = await Promise.allSettled([selected, traffic]);
  for (const result of results) assert.equal(result.status, "fulfilled", String(result.reason));
  if (version === targetVersion) {
    const upgrades = await Promise.all([
      client.projects.upgrade(app.id),
      ...Array.from({ length: 30 }, async () => {
        const response = await fetch(urls[1], { signal: AbortSignal.timeout(30_000) });
        assert.equal(response.status, 200); await response.arrayBuffer();
      }),
    ]);
    assert.equal(upgrades[0].runtime.status, "running");
    assert.equal(upgrades[0].runtime.url, started.runtime.url);
    assert.equal(upgrades[0].recipe.version, recipeManifest.version);
    const descriptor = JSON.parse(await readFile(`/var/lib/zelavis/projects/${app.id}/project.json`, "utf8"));
    assert.equal(descriptor.engine.runtime.version, targetVersion);
    console.log("PASS: the App upgrades its exact engine and recipe live at the same address.");
  }
  assert.equal(execFileSync("systemctl", ["show", "zelavis.service", "-p", "MainPID", "--value"], { encoding: "utf8" }).trim(), platformPid);
  assert.deepEqual(await identities(), before);
  assert.equal((await client.projects.get(wp.id)).preview.port, wp.preview.port);
  assert.equal((await client.projects.get(app.id)).runtime.url, started.runtime.url);
  assert.equal(JSON.parse(await readFile("/opt/zelavis/installation.json", "utf8")).version, version);
  const ownerFile = JSON.parse(await readFile("/var/lib/zelavis/.platform-owner.json", "utf8"));
  const engineCommand = await readFile(`/proc/${ownerFile.pid}/cmdline`, "utf8");
  assert.ok(engineCommand.includes(`/releases/${version}/runtime/node/bin/node`), engineCommand);
  console.log(`PASS: qualified private engine ${version}, same Platform host, App/WordPress PIDs, preview ports and continuous HTTP traffic.`);
}
const descriptor = JSON.parse(await readFile(`/var/lib/zelavis/projects/${app.id}/project.json`, "utf8"));
assert.equal(descriptor.engine.runtime.version, targetVersion, "parent rollback leaves the App engine pin untouched");
const latestApp = await client.projects.create({ id: "latest-qualified", name: "Latest Qualified", start: false });
const latestDescriptor = JSON.parse(await readFile(`/var/lib/zelavis/projects/${latestApp.id}/project.json`, "utf8"));
assert.equal(latestDescriptor.engine.runtime.version, targetVersion, "new Projects select the latest qualified engine even on an older parent");
await client.projects.remove(latestApp.id);
await client.projects.remove(app.id);
