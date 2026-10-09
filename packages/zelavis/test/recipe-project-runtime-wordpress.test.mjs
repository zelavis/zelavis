// The real WordPress recipe through the generic recipe runtime, with the real Nginx, PHP-FPM and
// MariaDB of this host (skipped where they are not installed). WordPress itself is replaced by a
// two-file stand-in placed where the recipe looks first, so nothing is downloaded; everything
// else (requirements, ports, the install and start phases in their own processes, MariaDB
// initialization, supervision, restart, removal) is the production path.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { Agent, get as httpGet } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { createRecipeProjectRuntime } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { resolveRequirementCommands } from "../dist/adapters/_recipe-requirements.js";
import { loopbackPortAccepts } from "../dist/adapters/_loopback-probe.js";
import { digestArtifactDirectory, materializeRecipeArtifact } from "../dist/adapters/_recipe-artifact.js";

const wordpress = new URL("../../../zelavis-services/wordpress/", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(wordpress, "package.json"), "utf8"));
const stack = await Effect.runPromise(resolveRequirementCommands(["nginx", "php-fpm", "mariadb"]).pipe(Effect.option, Effect.map((result) => result._tag === "Some")));
const skip = !stack || !existsSync(join(wordpress, "dist/recipe.js")) ? "needs Nginx, PHP-FPM, MariaDB and a built @zelavis/wordpress" : false;

const lock = (software) => ({
  name: "@zelavis/wordpress", title: "WordPress", version: manifest.version, specifier: "@zelavis/wordpress", runtimeKinds: ["native"],
  install: { method: "native", driver: "js", requires: ["nginx", "php-fpm", "mariadb"], software },
});
const record = (id, software) => ({ id, name: id, kind: "wordpress", recipe: lock(software), runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "provisioning" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

// A request on its own connection: a reused keep-alive socket that the server closes while a request is
// in flight is a client-side race on any reload, not an outage, and would make this proof flaky.
const oneConnection = new Agent({ keepAlive: false });
const oneShot = (url) => new Promise((resolve, reject) => {
  httpGet(url, { agent: oneConnection }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body, header: response.headers["x-recipe"] }));
    response.on("error", reject);
  }).on("error", reject);
});

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

const execute = (file, args) => new Promise((resolve, reject) => execFile(file, args, (error, stdout, stderr) => error ? reject(new Error(`${file}: ${stderr || error.message}`)) : resolve(stdout)));

test("a WordPress Project laid out by the previous recipe is taken over: same address, same database, same files", { skip, timeout: 240_000 }, async (t) => {
  const { driver, directory } = await setup(t);
  const id = "legacy";
  const zelavis = join(directory, id, ".zelavis");
  const password = "legacy-database-password-0123";
  const ports = { http: 41231, database: 41232 };
  // The previous recipe's layout: WordPress in `.zelavis/wordpress` with a configuration naming its
  // database port and password, a MariaDB directory in `.zelavis/mariadb`, and its state file.
  await mkdir(join(zelavis, "wordpress", "wp-includes"), { recursive: true });
  await mkdir(join(zelavis, "wordpress", "wp-content", "uploads"), { recursive: true });
  await writeFile(join(zelavis, "wordpress", "wp-includes", "version.php"), "<?php $wp_version = '7.0.9';");
  await writeFile(join(zelavis, "wordpress", "wp-content", "uploads", "photo.txt"), "an upload");
  await writeFile(join(zelavis, "wordpress", "index.php"), STAND_IN_INDEX);
  await writeFile(join(zelavis, "wordpress", "wp-config.php"), `<?php\ndefine('DB_NAME', 'wordpress');\ndefine('DB_USER', 'wordpress');\ndefine('DB_PASSWORD', '${password}');\ndefine('DB_HOST', '127.0.0.1:${ports.database}');\n`);
  await mkdir(join(zelavis, "mariadb"), { recursive: true });
  const sql = join(zelavis, "legacy-init.sql");
  await writeFile(sql, `FLUSH PRIVILEGES;\nCREATE DATABASE wordpress;\nCREATE USER 'wordpress'@'127.0.0.1' IDENTIFIED BY '${password}';\nGRANT ALL ON wordpress.* TO 'wordpress'@'127.0.0.1';\nFLUSH PRIVILEGES;\nCREATE TABLE wordpress.wp_options (name VARCHAR(40), value VARCHAR(80));\nINSERT INTO wordpress.wp_options VALUES ('siteurl', 'kept');\n`);
  const tools = await Effect.runPromise(resolveRequirementCommands(["mariadb"]));
  await execute(tools["mariadb-install-db"], [`--datadir=${join(zelavis, "mariadb")}`, "--auth-root-authentication-method=normal", "--skip-test-db", `--extra-file=${sql}`]);
  await rm(sql);
  await writeFile(join(zelavis, "wordpress-native.json"), JSON.stringify({ httpPort: ports.http, databasePort: ports.database, databaseName: "wordpress", databaseUser: "wordpress", databasePassword: password, socketId: "legacysock01", databaseInitialized: true, nginx: "nginx" }));
  await writeFile(join(zelavis, "nginx.conf"), "the previous recipe's generated configuration");

  const project = record(id, "7.1.2");
  await driver.prepare(project, project.recipe);
  const root = join(directory, id, "app");
  assert.equal(await readFile(join(root, "site", "wp-content", "uploads", "photo.txt"), "utf8"), "an upload");
  assert.equal(existsSync(join(zelavis, "wordpress")), false);
  assert.equal(existsSync(join(zelavis, "mariadb")), false);

  const started = await driver.start(project);
  assert.equal(started.url, `http://127.0.0.1:${ports.http}`, "the address the Project already had");
  assert.match(await (await fetch(`${started.url}/index.php`)).text(), /^database:1 php:\d+$/, "PHP reaches the database it always had, with the password it always had");
  const rows = await execute(tools.mariadb, ["--protocol=tcp", "-h127.0.0.1", `-P${ports.database}`, "-uwordpress", `-p${password}`, "-N", "-e", "select value from wordpress.wp_options where name='siteurl'"]);
  assert.equal(rows.trim(), "kept", "the data in the database is the data that was there");
  assert.equal(await readFile(join(root, "site", "wp-includes", "version.php"), "utf8"), "<?php $wp_version = '7.0.9';", "the application's files are untouched: the recipe pins 7.1.2 but this site stays what it is");
  assert.equal(existsSync(join(zelavis, "wordpress-native.json")), false, "committed once it ran");
  assert.equal(existsSync(join(zelavis, "nginx.conf")), false);
  await driver.stop(id);
});

test("a running WordPress Project is upgraded to a recipe that changes its web configuration: nginx and PHP-FPM reload in place, the database is untouched, no request fails", { skip, timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "zv-wp-live-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  t.after(async () => { await runner.close(); await rm(base, { recursive: true, force: true }); });

  // Two versions of the real recipe: the second sets a header on every response, a change of nginx's configuration only.
  const copy = async (name, version, edit) => {
    const target = join(base, name);
    await mkdir(target, { recursive: true });
    await cp(join(wordpress, "dist"), join(target, "dist"), { recursive: true });
    const manifestFile = JSON.parse(await readFile(join(wordpress, "package.json"), "utf8"));
    await writeFile(join(target, "package.json"), JSON.stringify({ ...manifestFile, version }));
    if (edit) {
      const recipeFile = join(target, "dist", "recipe.js");
      await writeFile(recipeFile, edit(await readFile(recipeFile, "utf8")));
    }
    return target;
  };
  const sources = {
    "7.1.3": await copy("wp-one", "7.1.3"),
    "7.1.4": await copy("wp-two", "7.1.4", (text) => {
      assert.ok(text.includes("client_max_body_size 64m;"), "the recipe still has the line this test edits");
      return text.replace("client_max_body_size 64m;", 'client_max_body_size 64m;\n  add_header X-Recipe "two" always;');
    }),
  };
  const id = "wplive";
  const data = join(directory, id, ".zelavis");
  await mkdir(data, { recursive: true });
  const { digest } = await materializeRecipeArtifact(sources["7.1.3"], data);
  const locked = (version, artifact) => ({ ...lock("7.1.2"), version, ...(artifact ? { artifact: { digest: artifact } } : {}) });
  const project = { ...record(id, "7.1.2"), recipe: locked("7.1.3", digest) };
  const driver = createRecipeProjectRuntime({
    name: "native-wordpress", description: "test", directory, packageDirectory: join(data, "recipe", "package"), agent: runner,
    recipes: {
      source: async (name, version) => name === "@zelavis/wordpress" ? sources[version] : undefined,
      stage: (source, dataDirectory) => materializeRecipeArtifact(source, dataDirectory),
      digest: (packageDirectory) => digestArtifactDirectory(packageDirectory),
    },
  });
  t.after(() => driver.close().catch(() => undefined));
  const site = join(directory, id, "app", "site");
  await mkdir(join(site, "wp-includes"), { recursive: true });
  await writeFile(join(site, "wp-includes", "version.php"), "<?php $wp_version = 'stand-in';");
  await writeFile(join(site, "index.php"), STAND_IN_INDEX);

  await driver.prepare(project, project.recipe);
  const started = await driver.start(project);
  const read = (file) => Number(readFileSync(join(directory, id, "app", "run", file), "utf8").trim());
  const pids = () => ({ nginx: read("nginx.pid"), fpm: read("php-fpm.pid"), database: read("mariadb.pid") });
  const before = pids();
  const first = await fetch(`${started.url}/index.php`);
  assert.equal(first.headers.get("x-recipe"), null);
  assert.match(await first.text(), /database:1/);

  let stop = false; let failures = 0; let served = 0; const headers = new Set();
  const traffic = (async () => {
    while (!stop) {
      try {
        const response = await oneShot(`${started.url}/index.php`);
        if (response.status !== 200 || !/database:1/.test(response.body)) failures += 1; else served += 1;
        headers.add(response.header ?? null);
      } catch { failures += 1; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const execution = await driver.prepareUpdate(project, { ...project, recipe: locked("7.1.4") });
  await driver.applyUpdate(id, execution, async () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  stop = true; await traffic;

  assert.equal(failures, 0, "not one request failed while WordPress changed recipe");
  assert.ok(served > 50, `served ${served}`);
  assert.deepEqual([...headers].sort((a, b) => String(a).localeCompare(String(b))), [null, "two"], "responses switched to the new configuration");
  assert.deepEqual(pids(), before, "Nginx, PHP-FPM and MariaDB are the same processes");
  const after = await fetch(`${started.url}/index.php`);
  assert.equal(after.headers.get("x-recipe"), "two");
  assert.match(await after.text(), /database:1/);
  assert.equal(JSON.parse(await readFile(join(data, "recipe", "package", "package.json"), "utf8")).version, "7.1.4");
  assert.match(readFileSync(join(directory, id, "app", "nginx.conf"), "utf8"), /X-Recipe/);
  await driver.stop(id);
});
