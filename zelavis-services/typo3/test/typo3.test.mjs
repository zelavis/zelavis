import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { Effect } from "effect";
import { RecipeHost, listSetupValues, parseProcessPlan, parseRecipeManifest } from "zelavis/recipe";

import recipe from "../dist/recipe.js";
import { TYPO3_APP_NAME, createProjectRuntime } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const install = parseRecipeManifest(manifest.zelavis.project.install);

test("the manifest pins one TYPO3 release, needs the web and database tiers, and declares what TYPO3's installer asks for", async () => {
  assert.equal(manifest.name, TYPO3_APP_NAME);
  assert.deepEqual(manifest.zelavis.project.hostPackages, ["mariadb-server"]);
  assert.deepEqual(install.methods.map((method) => [method.id, [...method.requires]]), [["native", []], ["container", ["docker"]]]);
  await access(new URL(`../${install.methods[0].entry}`, import.meta.url));
  assert.deepEqual(install.directories, [{ name: "site", path: "site", backup: "files" }, { name: "db", path: "db", backup: "recipe" }], "the site is copied, the database dumped by the recipe");
  for (const software of install.software) {
    assert.match(software.sha256, /^[0-9a-f]{64}$/);
    assert.match(software.archive, /^https:\/\/cdn\.typo3\.com\/typo3\/[\d.]+\/typo3_src-[\d.]+\.tar\.gz$/);
  }
  assert.match(manifest.zelavis.project.managed.adminPath, /^\/[A-Za-z0-9._\/-]*$/);
});

test("PHP and the web server are the recipe's own: pinned builds for every platform, not the host's", () => {
  assert.deepEqual(install.runtimes.map((runtime) => runtime.command), ["php", "php-fpm", "caddy", "mariadbd", "mariadb-install-db", "mariadb", "mariadb-dump"]);
  for (const runtime of install.runtimes.filter((entry) => entry.hostRequirement === undefined)) {
    assert.match(runtime.version, runtime.command === "caddy" ? /^2\.\d+\.\d+$/ : /^8\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(runtime.downloads).sort(), ["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64"]);
    for (const download of Object.values(runtime.downloads)) assert.match(download.sha256, /^[0-9a-f]{64}$/);
  }
});

test("MariaDB is the recipe's own where the vendor builds it, and the host's elsewhere", () => {
  const database = install.runtimes.filter((runtime) => runtime.hostRequirement === "mariadb");
  assert.deepEqual(database.map((runtime) => runtime.command), ["mariadbd", "mariadb-install-db", "mariadb", "mariadb-dump"]);
  for (const runtime of database) {
    assert.deepEqual(Object.keys(runtime.downloads), ["linux-x86_64"]);
    assert.match(runtime.downloads["linux-x86_64"].archive, /^https:\/\/archive\.mariadb\.org\/mariadb-[\d.]+\/bintar-linux-systemd-x86_64\//);
  }
  assert.equal(new Set(database.map((runtime) => runtime.downloads["linux-x86_64"].sha256)).size, 1, "one archive serves all three commands");
});

test("its runtime is the Platform's recipe runtime", () => {
  const driver = createProjectRuntime({ directory: "/tmp/zv-typo3-test", packageDirectory: new URL("..", import.meta.url).pathname, agent: { start: async () => { throw new Error("not started"); } }, options: {} });
  assert.equal(driver.name, "native-typo3");
  assert.match(driver.capabilities({}).description, /TYPO3/);
});

const context = (overrides = {}) => ({
  projectId: "p1", hostname: "localhost", software: install.software[0], method: install.methods[0], config: {},
  ports: { web: 18080, db: 13306 },
  directories: { root: "/srv/p1/.zelavis/server", sockets: "/run/zv-abc", named: { site: "/srv/p1/app/site", db: "/srv/p1/app/db" } },
  account: { user: "www-data", group: "www-data", switchUser: false },
  ...overrides,
});

/** An in-memory host that records what the recipe asks for. */
function fakeHost(existing = []) {
  const files = new Map(existing.map((path) => [path, "existing"]));
  const calls = { writes: new Map(), runs: [], downloads: [], extracts: [], removed: [], secrets: [] };
  const host = {
    files: {
      read: (path) => Effect.succeed(files.get(path) ?? ""),
      exists: (path) => Effect.succeed(files.has(path)),
      write: (path, content) => Effect.sync(() => { files.set(path, "written"); calls.writes.set(path, content); }),
      mkdir: (path) => Effect.sync(() => { files.set(path, "dir"); }),
      remove: (path) => Effect.sync(() => { calls.removed.push(path); for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key); }),
    },
    download: (input) => Effect.sync(() => { calls.downloads.push(input); files.set(input.destination, "archive"); }),
    extract: (archive, destination, options) => Effect.sync(() => { calls.extracts.push({ archive, destination, options }); files.set(`${destination}/typo3/index.php`, "x"); }),
    run: (input) => Effect.sync(() => {
      calls.runs.push(input);
      if (input.command === "php" && input.args[0] === "-r" && input.args[1].includes("extension_loaded")) return { code: 0, stdout: "[]", stderr: "" };
      if (input.command === "php") return { code: 0, stdout: "8.4.1", stderr: "" };
      if (input.command === "php-fpm" && input.args[0] === "-v") return { code: 0, stdout: "PHP 8.4.1 (fpm-fcgi)", stderr: "" };
      if (input.command === "mariadbd") return { code: 0, stdout: "mariadbd  Ver 11.4.2-MariaDB", stderr: "" };
      if (input.command === "mariadb-install-db") files.set("db/mysql", "initialized");
      return { code: 0, stdout: "", stderr: "" };
    }),
    secret: (name) => Effect.sync(() => { calls.secrets.push(name); return { secret: name }; }),
    progress: () => Effect.void,
  };
  return { host, calls, files };
}
const runInstall = (fake, ctx = context()) => Effect.runPromise(recipe.install(ctx).pipe(Effect.provideService(RecipeHost, fake.host)));

test("start is the database, PHP-FPM and Caddy in dependency order, within the manifest's names", () => {
  const plan = Effect.runSync(recipe.start(context()));
  const checked = parseProcessPlan(plan, { commands: ["caddy", "php", "php-fpm", "mariadbd", "mariadb-install-db", "mariadb"], ports: install.ports.map((port) => port.name), directories: ["/srv/p1/.zelavis/server", "/srv/p1/app", "/run/zv-abc"] });
  assert.deepEqual(checked.processes.map((process) => [process.name, [...process.dependsOn]]), [["database", []], ["php-fpm", ["database"]], ["caddy", ["php-fpm"]]]);
  assert.ok(checked.processes[0].args.includes("--datadir=/srv/p1/app/db"));
});

test("install downloads the pinned release into the web root, creates the database and user, and writes no application configuration", async () => {
  const fake = fakeHost();
  await runInstall(fake);
  assert.deepEqual(fake.calls.extracts, [{ archive: "dl/typo3.tar.gz", destination: "/srv/p1/app/site", options: { stripTopLevel: true } }]);
  assert.ok(fake.files.has("/srv/p1/app/site/FIRST_INSTALL"), "TYPO3's installer is opened");
  const sql = fake.calls.writes.get("run/init.sql");
  assert.ok(sql.some((part) => typeof part === "string" && part.includes("`typo3`")) && sql.some((part) => part.secret === "db-password"));
  assert.ok(!fake.calls.writes.has("/srv/p1/app/site/typo3conf/system/settings.php"), "TYPO3's installer writes its own configuration");
  assert.match(fake.calls.writes.get("Caddyfile"), /root \* "\/srv\/p1\/app\/site"/);
  assert.match(fake.calls.writes.get("Caddyfile"), /php_fastcgi/, "PHP is reached through Caddy, which passes the requested host as the server name");
});

test("the values TYPO3's installer asks for are the Project's setup values, with the password only revealed", () => {
  const source = { ports: { web: 18080, db: 13306 }, directories: { site: "/srv/p1/app/site", db: "/srv/p1/app/db" }, root: "/srv/p1/app", sockets: "/run/zv-abc", user: "www-data" };
  const listed = listSetupValues(install, source);
  assert.deepEqual(listed.map((entry) => [entry.id, entry.value]), [
    ["db-driver", "MySQLi"], ["db-host", "127.0.0.1"], ["db-port", "13306"], ["db-name", "typo3"], ["db-user", "typo3"], ["db-password", undefined],
  ]);
  assert.equal(listSetupValues(install, source, { "db-password": "generated" }).at(-1).value, "generated");
});

test("install refuses what it cannot run, and says why", async () => {
  const noExtension = fakeHost();
  const run = noExtension.host.run;
  noExtension.host.run = (input) => input.command === "php" && input.args[1]?.includes?.("extension_loaded") ? Effect.succeed({ code: 0, stdout: '["mysqli"]', stderr: "" }) : run(input);
  await assert.rejects(runInstall(noExtension), /missing required PHP extensions: mysqli/);
});
