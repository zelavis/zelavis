// The real WordPress recipe through the generic recipe runtime, with the real Nginx, PHP-FPM and
// MariaDB of this host (skipped where they are not installed). WordPress itself is replaced by a
// two-file stand-in placed where the recipe looks first, so nothing is downloaded; everything
// else (requirements, ports, the install and start phases in their own processes, MariaDB
// initialization, supervision, restart, removal) is the production path.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { resolveRequirementCommands } from "../dist/adapters/_recipe-requirements.js";
import { loopbackPortAccepts } from "../dist/adapters/_loopback-probe.js";

const wordpress = new URL("../../../zelavis-services/wordpress/", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(wordpress, "package.json"), "utf8"));
const stack = await Effect.runPromise(resolveRequirementCommands(["nginx", "php-fpm", "mariadb"]).pipe(Effect.option, Effect.map((result) => result._tag === "Some")));
const skip = !stack || !existsSync(join(wordpress, "dist/recipe.js")) ? "needs Nginx, PHP-FPM, MariaDB and a built @zelavis/wordpress" : false;

const lock = (software) => ({
  name: "@zelavis/wordpress", title: "WordPress", version: manifest.version, specifier: "@zelavis/wordpress", runtimeKinds: ["native"],
  install: { method: "native", driver: "js", requires: ["nginx", "php-fpm", "mariadb"], software },
});
const record = (id, software) => ({ id, name: id, kind: "wordpress", recipe: lock(software), runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

const STAND_IN_INDEX = `<?php
$config = file_get_contents(__DIR__ . '/wp-config.php');
preg_match("/DB_PASSWORD', '([^']+)'/", $config, $password);
preg_match("/DB_HOST', '127.0.0.1:(\\\\d+)'/", $config, $port);
$link = new mysqli('127.0.0.1', 'wordpress', $password[1], 'wordpress', (int) $port[1]);
echo 'database:' . $link->query('select 1')->fetch_row()[0] . ' php:' . PHP_MAJOR_VERSION;
`;

async function setup(t) {
  const base = await mkdtemp(join(tmpdir(), "zv-wp-recipe-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const driver = createRecipeProjectRuntime({
    name: "native-wordpress", description: "test", directory, packageDirectory: wordpress, agent: runner,
  });
  t.after(async () => { await driver.close().catch(() => undefined); await runner.close(); await rm(base, { recursive: true, force: true }); });
  const seedSite = async (id) => {
    const site = join(directory, id, "app", "site");
    await mkdir(join(site, "wp-includes"), { recursive: true });
    await writeFile(join(site, "wp-includes", "version.php"), "<?php $wp_version = 'stand-in';");
    await writeFile(join(site, "index.php"), STAND_IN_INDEX);
  };
  return { directory, runner, driver, seedSite };
}

test("a WordPress Project installs, starts, serves PHP backed by its own database, stops, restarts and is removed", { skip, timeout: 240_000 }, async (t) => {
  const { driver, directory, seedSite } = await setup(t);
  await seedSite("wp1");
  const project = record("wp1", "7.1.2");
  await driver.prepare(project, project.recipe);

  const where = join(directory, "wp1");
  const state = JSON.parse(readFileSync(join(where, ".zelavis", "recipe-state.json"), "utf8"));
  assert.equal(state.installed, true);
  assert.deepEqual(Object.keys(state.ports).sort(), ["db", "web"]);
  for (const name of ["nginx", "php-fpm", "mariadbd", "mariadb-install-db", "mariadb", "php"]) assert.ok(state.commands[name]?.startsWith("/"), `${name} resolved to an absolute path`);
  assert.ok(existsSync(join(where, "app", "nginx.conf")) && existsSync(join(where, "app", "php-fpm.conf")));
  assert.ok(existsSync(join(where, "app", "db", ".zelavis-initialized")));
  assert.ok(!existsSync(join(where, "app", "run", "init.sql")), "the SQL file that held the password is gone");
  const config = readFileSync(join(where, "app", "site", "wp-config.php"), "utf8");
  assert.equal(statSync(join(where, "app", "site", "wp-config.php")).mode & 0o077, 0, "the configuration is private");
  const password = readFileSync(join(where, ".zelavis", "secrets", "db-password"), "utf8");
  assert.ok(config.includes(password) && !JSON.stringify(state).includes(password), "the password is in the config and the secrets directory only");
  assert.ok(existsSync(join(where, "project.json")));

  const started = await driver.start(project);
  assert.equal(started.status, "running");
  assert.equal(started.url, `http://127.0.0.1:${state.ports.web}`);
  const page = await fetch(`${started.url}/index.php`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /^database:1 php:\d+$/, "Nginx → PHP-FPM → MariaDB with the generated credentials");
  assert.equal((await driver.status("wp1")).status, "running");
  assert.ok((await driver.logs("wp1")).some((entry) => /Installing @zelavis\/wordpress 7\.1\.2/.test(entry.message)));

  await driver.stop("wp1");
  assert.equal((await driver.status("wp1")).status, "stopped");
  assert.equal(await Effect.runPromise(loopbackPortAccepts(state.ports.web)), false);
  assert.equal(await Effect.runPromise(loopbackPortAccepts(state.ports.db)), false);

  // The same Project again: the database already exists, nothing is installed twice.
  await driver.prepare(project, project.recipe);
  const again = await driver.start(project);
  assert.equal(again.url, started.url, "the same address after a restart");
  assert.match(await (await fetch(`${again.url}/index.php`)).text(), /database:1/);
  await driver.stop("wp1");

  await driver.destroy("wp1");
  assert.equal(existsSync(where), false);
  assert.equal(existsSync(join(directory, "..", "runtime-sockets")) && existsSync(join(directory, "..", "runtime-sockets", `zv-${state.socketId}`)), false);
});

test("a start that finds a stale socket does not mistake it for a running PHP-FPM", { skip, timeout: 240_000 }, async (t) => {
  const { driver, directory, seedSite } = await setup(t);
  await seedSite("wp2");
  const project = record("wp2", "7.1.2");
  await driver.prepare(project, project.recipe);
  const state = JSON.parse(readFileSync(join(directory, "wp2", ".zelavis", "recipe-state.json"), "utf8"));
  const sockets = process.platform === "linux" ? join(directory, "..", "runtime-sockets", `zv-${state.socketId}`) : join("/tmp", `zv-${state.socketId}`);
  await writeFile(join(sockets, "php-fpm.sock"), "left behind by a crash");
  assert.ok(existsSync(join(sockets, "php-fpm.sock")));
  const started = await driver.start(project);
  assert.match(await (await fetch(`${started.url}/index.php`)).text(), /database:1/);
  await driver.stop("wp2");
  await writeFile(join(sockets, "php-fpm.sock"), "left behind by a crash");
  await writeFile(join(sockets, "other.sock"), "x");
  await driver.start(project);
  assert.equal(existsSync(join(sockets, "other.sock")), false, "the socket directory is cleared at start");
  await driver.stop("wp2");
});

test("an unsupported install lock is refused before anything is created", { timeout: 60_000 }, async (t) => {
  const { driver, directory } = await setup(t);
  const missing = record("wp3", "7.1.2");
  delete missing.recipe.install;
  await assert.rejects(driver.prepare(missing, missing.recipe), /has no install lock/);
  const other = record("wp3", "9.9.9");
  await assert.rejects(driver.prepare(other, other.recipe), /does not offer software 9\.9\.9/);
  const wrongMethod = record("wp3", "7.1.2");
  wrongMethod.recipe.install = { ...wrongMethod.recipe.install, method: "container", driver: "oci" };
  await assert.rejects(driver.prepare(wrongMethod, wrongMethod.recipe), /JavaScript install methods/);
  assert.equal(existsSync(join(directory, "wp3")), false);
});
