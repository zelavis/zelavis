import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { Effect } from "effect";
import { RecipeHost, parseProcessPlan, parseRecipeManifest } from "zelavis/recipe";

import recipe from "../dist/recipe.js";
import { WORDPRESS_APP_NAME, createProjectRuntime } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const install = parseRecipeManifest(manifest.zelavis.project.install);

test("recipe revisions are independent from the pinned WordPress releases", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.ok(install.software.length >= 1);
  for (const software of install.software) {
    assert.match(software.version, /^\d+\.\d+(?:\.\d+)?$/);
    assert.match(software.sha256, /^[0-9a-f]{64}$/, "the archive has a pinned SHA-256");
    assert.equal(software.archive, `https://wordpress.org/wordpress-${software.version}.tar.gz`);
  }
  assert.deepEqual(manifest.zelavis.project.hostPackages, ["wordpress-stack"]);
});

test("the manifest declares one JavaScript method whose module exists, and the ports the recipe uses", async () => {
  assert.equal(manifest.name, WORDPRESS_APP_NAME);
  assert.equal(manifest.zelavis.kind, "app");
  assert.deepEqual(manifest.zelavis.project.runtimeKinds, ["native"]);
  assert.deepEqual(install.methods.map((method) => [method.id, method.driver, [...method.requires]]), [["native", "js", ["nginx", "php-fpm", "mariadb"]]]);
  await access(new URL(`../${install.methods[0].entry}`, import.meta.url));
  assert.deepEqual(install.ports.map((port) => [port.name, port.protocol]), [["web", "http"], ["db", "tcp"]]);
  assert.equal(manifest.zelavis.project.runtime, "./dist/runtime.js");
  await access(new URL("../dist/runtime.js", import.meta.url));
  assert.ok(manifest.files.includes("dist"), "the recipe is part of what is published and frozen");
});

test("its runtime is the Platform's recipe runtime, configured by the host's user option", () => {
  const agent = { start: async () => { throw new Error("not started"); } };
  const driver = createProjectRuntime({ directory: "/tmp/zv-wp-test", packageDirectory: new URL("..", import.meta.url).pathname, agent, options: { user: "www" } });
  assert.equal(driver.name, "native-wordpress");
  assert.deepEqual([...driver.runtimeKinds], ["native"]);
  assert.match(driver.capabilities({}).description, /WordPress/);
});

const context = (overrides = {}) => ({
  projectId: "p1", hostname: "localhost", software: install.software[0], method: install.methods[0], config: {},
  ports: { web: 18080, db: 13306 },
  directories: { root: "/srv/p1/app", sockets: "/run/zv-abc" },
  account: { user: "www-data", group: "www-data", switchUser: false },
  ...overrides,
});

test("start returns the three processes, in dependency order, within the manifest's names", () => {
  const plan = Effect.runSync(recipe.start(context()));
  const checked = parseProcessPlan(plan, {
    commands: ["nginx", "php", "php-fpm", "mariadbd", "mariadb-install-db", "mariadb"], ports: install.ports.map((port) => port.name),
    directories: ["/srv/p1/app", "/run/zv-abc"],
  });
  assert.deepEqual(checked.processes.map((process) => [process.name, process.command, [...process.dependsOn]]), [
    ["database", "mariadbd", []], ["php-fpm", "php-fpm", ["database"]], ["nginx", "nginx", ["php-fpm"]],
  ]);
  const database = checked.processes[0];
  assert.ok(database.args.includes("--datadir=/srv/p1/app/db") && database.args.includes("--port=13306") && database.args.includes("--bind-address=127.0.0.1"));
  assert.ok(!database.args.some((arg) => String(arg).startsWith("--user=")), "an unprivileged Platform does not ask MariaDB to switch user");
  assert.deepEqual(checked.processes[1].readiness, { path: "/run/zv-abc/php-fpm.sock", timeoutMs: 120000 });
  assert.deepEqual(checked.processes[2].readiness, { port: "web", timeoutMs: 120000 });

  const root = Effect.runSync(recipe.start(context({ account: { user: "www-data", group: "www-data", switchUser: true } })));
  assert.ok(root.processes[0].args.includes("--user=www-data"), "a root Platform has MariaDB drop to the account");
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
    extract: (archive, destination, options) => Effect.sync(() => { calls.extracts.push({ archive, destination, options }); files.set(`${destination}/wp-includes/version.php`, "x"); }),
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

test("install downloads the pinned release, writes private credentials by reference, and initializes the database once", async () => {
  const fake = fakeHost();
  await runInstall(fake);
  assert.deepEqual(fake.calls.downloads.map((d) => [d.url, d.sha256, d.maxBytes, d.destination]), [[install.software[0].archive, install.software[0].sha256, install.software[0].maxBytes, "dl/wordpress.tar.gz"]]);
  assert.deepEqual(fake.calls.extracts, [{ archive: "dl/wordpress.tar.gz", destination: "site", options: { stripTopLevel: true } }]);
  const config = fake.calls.writes.get("site/wp-config.php");
  assert.ok(Array.isArray(config) && config.some((part) => part.secret === "db-password"), "the password is a reference");
  assert.equal(config.filter((part) => typeof part === "object").length, 9, "one password and eight salts");
  assert.ok(config.join("").includes("DB_HOST', '127.0.0.1:13306'"));
  const sql = fake.calls.writes.get("run/init.sql");
  assert.ok(sql[0].startsWith("FLUSH PRIVILEGES;"), "account management is switched on before accounts are created");
  assert.ok(sql.some((part) => part.secret === "db-password"));
  const initialize = fake.calls.runs.find((call) => call.command === "mariadb-install-db");
  assert.ok(initialize.args.includes("--extra-file=/srv/p1/app/run/init.sql") && initialize.args.includes("--datadir=/srv/p1/app/db"));
  assert.ok(fake.calls.removed.includes("run/init.sql"), "the file that held the password is removed");
  assert.ok(fake.files.has("db/.zelavis-initialized"));
  assert.ok(fake.calls.runs.some((call) => call.command === "nginx" && call.args[0] === "-t"));
  assert.ok(fake.calls.runs.some((call) => call.command === "php-fpm" && call.args[0] === "-tt"));
});

test("install resumes: nothing is downloaded, regenerated or reinitialized when it is already there", async () => {
  const fake = fakeHost(["site/wp-includes/version.php", "site/wp-config.php", "db/.zelavis-initialized"]);
  await runInstall(fake);
  assert.deepEqual(fake.calls.downloads, []);
  assert.equal(fake.calls.writes.has("site/wp-config.php"), false);
  assert.equal(fake.calls.runs.some((call) => call.command === "mariadb-install-db"), false);
  assert.ok(fake.calls.writes.has("nginx.conf") && fake.calls.writes.has("php-fpm.conf"), "configuration is regenerated, it is cheap and keeps ports current");
});

test("configuration follows the account: nginx drops privileges only when asked, PHP-FPM names the account", async () => {
  const plain = fakeHost();
  await runInstall(plain);
  assert.ok(!plain.calls.writes.get("nginx.conf").startsWith("user "));
  const fpm = plain.calls.writes.get("php-fpm.conf");
  assert.match(fpm, /user = www-data\ngroup = www-data/);
  assert.match(fpm, /listen = \/run\/zv-abc\/php-fpm\.sock/);
  assert.match(fpm, /listen\.mode = 0600/);

  const root = fakeHost();
  await runInstall(root, context({ account: { user: "www-data", group: "web", switchUser: true } }));
  assert.ok(root.calls.writes.get("nginx.conf").startsWith("user www-data;"));
  assert.match(root.calls.writes.get("php-fpm.conf"), /group = web/);
  assert.ok(root.calls.runs.find((call) => call.command === "mariadb-install-db").args.includes("--user=www-data"));
});

test("install refuses what it cannot run, and says why", async () => {
  const oldPhp = fakeHost();
  const run = oldPhp.host.run;
  oldPhp.host.run = (input) => input.command === "php" && input.args[0] === "-r" && !input.args[1].includes("extension_loaded")
    ? Effect.succeed({ code: 0, stdout: "8.1.9", stderr: "" }) : run(input);
  await assert.rejects(runInstall(oldPhp), /PHP CLI and PHP-FPM 8\.2 or newer/);

  const noExtension = fakeHost();
  const run2 = noExtension.host.run;
  noExtension.host.run = (input) => input.command === "php" && input.args[1]?.includes?.("extension_loaded")
    ? Effect.succeed({ code: 0, stdout: '["gd","intl"]', stderr: "" }) : run2(input);
  await assert.rejects(runInstall(noExtension), /missing required PHP extensions: gd, intl/);

  const oldDatabase = fakeHost();
  const run3 = oldDatabase.host.run;
  oldDatabase.host.run = (input) => input.command === "mariadbd" ? Effect.succeed({ code: 0, stdout: "mariadbd Ver 10.3.1-MariaDB", stderr: "" }) : run3(input);
  await assert.rejects(runInstall(oldDatabase), /MariaDB 10\.6 or newer/);

  const badConfig = fakeHost();
  const run4 = badConfig.host.run;
  badConfig.host.run = (input) => input.command === "nginx" ? Effect.succeed({ code: 1, stdout: "", stderr: "nginx: [emerg] unknown directive" }) : run4(input);
  await assert.rejects(runInstall(badConfig), /Nginx configuration is not valid: nginx: \[emerg\] unknown directive/);

  const brokenInit = fakeHost();
  const run5 = brokenInit.host.run;
  brokenInit.host.run = (input) => input.command === "mariadb-install-db" ? Effect.succeed({ code: 1, stdout: "", stderr: "ERROR: 1290 cannot execute" }) : run5(input);
  await assert.rejects(runInstall(brokenInit), /could not initialize its data directory: ERROR: 1290/);
  assert.equal(brokenInit.files.has("db/.zelavis-initialized"), false, "a failed initialization is not marked done");
  assert.ok(brokenInit.calls.removed.includes("run/init.sql"));
});
