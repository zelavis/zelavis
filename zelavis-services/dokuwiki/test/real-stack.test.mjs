// The whole recipe on a real host with nothing installed: it downloads its own PHP and web server (about
// 80 MB) and DokuWiki, and serves the installer. Off unless asked for, because it needs the network.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalAgentProcessRunner } from "../../../packages/zelavis/dist/adapters/_agent-process-runner.js";
import { createRecipeProjectRuntime } from "../../../packages/zelavis/dist/adapters/_recipe-project-runtime.js";

const skip = process.env.ZELAVIS_REAL_STACK === "1" ? false : "set ZELAVIS_REAL_STACK=1 to download and run the real stack";
const packageDirectory = new URL("..", import.meta.url).pathname;

test("DokuWiki runs from its own PHP and Caddy on a host that has neither", { skip, timeout: 600_000 }, async (t) => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const base = await mkdtemp(join(tmpdir(), "zv-dokuwiki-real-"));
  const directory = join(base, "projects");
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const driver = createRecipeProjectRuntime({ name: "native-dokuwiki", description: "real stack", directory, packageDirectory, agent });
  t.after(async () => { await driver.stop("wiki").catch(() => undefined); await driver.close().catch(() => undefined); await agent.close(); await rm(base, { recursive: true, force: true }); });
  const software = manifest.zelavis.project.install.software[0].version;
  const project = {
    id: "wiki", name: "wiki", kind: "dokuwiki", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recipe: { name: manifest.name, title: "DokuWiki", version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"], install: { method: "native", driver: "js", requires: [], software } },
  };
  await driver.prepare(project, project.recipe);
  const started = await driver.start(project);
  assert.equal(started.status, "running");
  const installer = await fetch(`${started.url}/install.php`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), /DokuWiki/);
  for (const path of ["/conf/dokuwiki.php", "/data/", "/inc/init.php"]) assert.equal((await fetch(`${started.url}${path}`)).status, 403, path);
});
