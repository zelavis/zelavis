import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { Effect } from "effect";
import { RecipeHost, listSetupValues, parseProcessPlan, parseRecipeManifest } from "zelavis/recipe";

import recipe from "../dist/recipe.js";
import { JOOMLA_APP_NAME, createProjectRuntime } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const install = parseRecipeManifest(manifest.zelavis.project.install);

test("the manifest pins one Joomla release, needs the web and database tiers, and declares what Joomla's installer asks for", async () => {
  assert.equal(manifest.name, JOOMLA_APP_NAME);
  assert.deepEqual(manifest.zelavis.project.hostPackages, ["php-stack", "mariadb-server"]);
  assert.deepEqual(install.methods.map((method) => [...method.requires]), [["nginx", "php-fpm", "mariadb"]]);
  await access(new URL(`../${install.methods[0].entry}`, import.meta.url));
  assert.deepEqual(install.directories, [{ name: "site", path: "site" }, { name: "db", path: "db" }]);
  for (const software of install.software) {
    assert.match(software.sha256, /^[0-9a-f]{64}$/);
    assert.match(software.archive, /^https:\/\/github\.com\/joomla\/joomla-cms\/releases\/download\/[\d.]+\/Joomla_[\d.]+-Stable-Full_Package\.tar\.gz$/);
  }
  assert.match(manifest.zelavis.project.managed.adminPath, /^\/[A-Za-z0-9._\/-]*$/);
});

test("its runtime is the Platform's recipe runtime", () => {
  const driver = createProjectRuntime({ directory: "/tmp/zv-joomla-test", packageDirectory: new URL("..", import.meta.url).pathname, agent: { start: async () => { throw new Error("not started"); } }, options: {} });
  assert.equal(driver.name, "native-joomla");
  assert.match(driver.capabilities({}).description, /Joomla/);
});

const context = (overrides = {}) => ({
  projectId: "p1", hostname: "localhost", software: install.software[0], method: install.methods[0], config: {},
  ports: { web: 18080, db: 13306 },
  directories: { root: "/srv/p1/app", sockets: "/run/zv-abc", named: { site: "/srv/p1/app/site", db: "/srv/p1/app/db" } },
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
    extract: (archive, destination, options) => Effect.sync(() => { calls.extracts.push({ archive, destination, options }); files.set(`${destination}/administrator/index.php`, "x"); }),
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

test("start is the database, PHP-FPM and Nginx in dependency order, within the manifest's names", () => {
  const plan = Effect.runSync(recipe.start(context()));
  const checked = parseProcessPlan(plan, { commands: ["nginx", "php", "php-fpm", "mariadbd", "mariadb-install-db", "mariadb"], ports: install.ports.map((port) => port.name), directories: ["/srv/p1/app", "/run/zv-abc"] });
  assert.deepEqual(checked.processes.map((process) => [process.name, [...process.dependsOn]]), [["database", []], ["php-fpm", ["database"]], ["nginx", ["php-fpm"]]]);
  assert.ok(checked.processes[0].args.includes("--datadir=/srv/p1/app/db"));
});

test("install downloads the pinned release without a top-level folder, creates the database and user, and writes no application configuration", async () => {
  const fake = fakeHost();
  await runInstall(fake);
  assert.deepEqual(fake.calls.extracts, [{ archive: "dl/joomla.tar.gz", destination: "site", options: {} }]);
  const sql = fake.calls.writes.get("run/init.sql");
  assert.ok(sql.some((part) => typeof part === "string" && part.includes("`joomla`")) && sql.some((part) => part.secret === "db-password"));
  assert.ok(!fake.calls.writes.has("site/configuration.php"), "Joomla's installer writes its own configuration");
  assert.match(fake.calls.writes.get("nginx.conf"), /root "\/srv\/p1\/app\/site"/);
});

test("the values Joomla's installer asks for are the Project's setup values, with the password only revealed", () => {
  const source = { ports: { web: 18080, db: 13306 }, directories: { site: "/srv/p1/app/site", db: "/srv/p1/app/db" }, root: "/srv/p1/app", sockets: "/run/zv-abc", user: "www-data" };
  const listed = listSetupValues(install, source);
  assert.deepEqual(listed.map((entry) => [entry.id, entry.value]), [
    ["db-type", "MySQLi"], ["db-host", "127.0.0.1:13306"], ["db-name", "joomla"], ["db-user", "joomla"], ["db-password", undefined],
  ]);
  assert.equal(listSetupValues(install, source, { "db-password": "generated" }).at(-1).value, "generated");
});

test("install refuses what it cannot run, and says why", async () => {
  const noExtension = fakeHost();
  const run = noExtension.host.run;
  noExtension.host.run = (input) => input.command === "php" && input.args[1]?.includes?.("extension_loaded") ? Effect.succeed({ code: 0, stdout: '["mysqli"]', stderr: "" }) : run(input);
  await assert.rejects(runInstall(noExtension), /missing required PHP extensions: mysqli/);
});
