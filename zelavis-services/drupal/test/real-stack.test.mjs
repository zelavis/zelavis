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

const dockerSkip = process.env.ZELAVIS_REAL_DOCKER === "1" ? false : "set ZELAVIS_REAL_DOCKER=1 to run the database in a container";

test("Drupal's container method runs MariaDB from the pinned image and Drupal connects to it", { skip: dockerSkip, timeout: 1_800_000 }, async (t) => {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const base = await mkdtemp(join(tmpdir(), "zv-drupal-docker-"));
  const directory = join(base, "projects");
  const agent = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const driver = createRecipeProjectRuntime({ name: "native-drupal", description: "real docker", directory, packageDirectory, agent });
  t.after(async () => { await driver.stop("site").catch(() => undefined); await driver.close().catch(() => undefined); await agent.close(); await rm(base, { recursive: true, force: true }); });
  const software = manifest.zelavis.project.install.software[0].version;
  const project = {
    id: "site", name: "site", kind: "drupal", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recipe: { name: manifest.name, title: "Drupal", version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"], install: { method: "container", driver: "js", requires: ["docker"], software } },
  };
  await driver.prepare(project, project.recipe);
  const state = JSON.parse(await readFile(join(directory, "site", ".zelavis", "recipe-state.json"), "utf8"));
  assert.ok(state.commands.docker, "the container engine is a declared command");
  assert.equal(state.commands.mariadbd, undefined, "no MariaDB program is downloaded or required for this method");
  const started = await driver.start(project);
  assert.equal(started.status, "running");
  const installer = await fetch(`${started.url}/core/install.php`);
  assert.equal(installer.status, 200);
  // The Project's own credentials open the database in the container.
  const password = (await readFile(join(directory, "site", ".zelavis", "secrets", "db-password"), "utf8")).trim();
  const php = state.commands.php;
  const { execFileSync } = await import("node:child_process");
  const outcome = execFileSync(php, ["-r", 'mysqli_report(MYSQLI_REPORT_OFF); $l = new mysqli("127.0.0.1", "drupal", $argv[1], "drupal", (int) $argv[2]); echo $l->connect_errno === 0 ? "connected" : "refused: " . $l->connect_error;', "--", password, String(state.ports.db)], { encoding: "utf8" });
  assert.equal(outcome, "connected");
  // The data survives a stop and a start: the image does not initialize a directory that is already a database.
  await driver.stop("site");
  await driver.prepare(project, project.recipe);
  const again = await driver.start(project);
  assert.equal(again.status, "running");
  assert.equal(execFileSync(php, ["-r", 'mysqli_report(MYSQLI_REPORT_OFF); $l = new mysqli("127.0.0.1", "drupal", $argv[1], "drupal", (int) $argv[2]); echo $l->connect_errno === 0 ? "connected" : "refused";', "--", password, String(state.ports.db)], { encoding: "utf8" }), "connected");
  await driver.stop("site");
  const left = execFileSync("docker", ["ps", "-aq", "--filter", "name=zv-site-database"], { encoding: "utf8" }).trim();
  assert.equal(left, "", "stopping the Project removes its container");
});
