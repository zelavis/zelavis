// The whole recipe on a real host with nothing installed: it downloads its own PHP, web server and MariaDB
// (about 450 MB) and Drupal, initializes the database, and serves Drupal's installer. Off unless asked for,
// because it needs the network. MariaDB is only built for Linux x86_64, so elsewhere the host's is used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalAgentProcessRunner } from "../../../packages/zelavis/dist/adapters/_agent-process-runner.js";
import { createRecipeProjectRuntime } from "../../../packages/zelavis/dist/adapters/_recipe-project-runtime.js";

const skip = process.env.ZELAVIS_REAL_STACK === "1" ? false : "set ZELAVIS_REAL_STACK=1 to download and run the real stack";
const packageDirectory = new URL("..", import.meta.url).pathname;

test("Drupal runs from its own PHP, Caddy and MariaDB on a host that has none of them", { skip, timeout: 1_800_000 }, async (t) => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const base = await mkdtemp(join(tmpdir(), "zv-drupal-real-"));
  const directory = join(base, "projects");
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const driver = createRecipeProjectRuntime({ name: "native-drupal", description: "real stack", directory, packageDirectory, agent });
  t.after(async () => { await driver.stop("site").catch(() => undefined); await driver.close().catch(() => undefined); await agent.close(); await rm(base, { recursive: true, force: true }); });
  const software = manifest.zelavis.project.install.software[0].version;
  const project = {
    id: "site", name: "site", kind: "drupal", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recipe: { name: manifest.name, title: "Drupal", version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"], install: { method: "native", driver: "js", requires: [], software } },
  };
  await driver.prepare(project, project.recipe);
  const state = JSON.parse(await readFile(join(directory, "site", ".zelavis", "recipe-state.json"), "utf8"));
  if (process.platform === "linux" && process.arch === "x64") {
    for (const name of ["mariadbd", "mariadb-install-db", "mariadb"]) assert.match(state.commands[name], /\/runtimes\/[0-9a-f]{64}\/mariadb-[\d.]+-linux-systemd-x86_64\//, `${name} is the recipe's own`);
  }
  const started = await driver.start(project);
  assert.equal(started.status, "running");
  const installer = await fetch(`${started.url}/core/install.php`);
  assert.equal(installer.status, 200);
  assert.match(await installer.text(), /Drupal/);
  for (const path of ["/sites/default/settings.php", "/core/modules/system/system.module", "/sites/default/files/x.php"]) assert.equal((await fetch(`${started.url}${path}`)).status, 403, path);
});
