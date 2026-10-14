import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { Effect } from "effect";
import { RecipeHost, parseProcessPlan, parseRecipeManifest } from "zelavis/recipe";

import recipe from "../dist/recipe.js";
import { DOKUWIKI_APP_NAME, createProjectRuntime } from "../dist/runtime.js";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const install = parseRecipeManifest(manifest.zelavis.project.install);

test("the manifest pins one DokuWiki release and declares the two things this recipe runs on", async () => {
  assert.equal(manifest.name, DOKUWIKI_APP_NAME);
  assert.equal(manifest.zelavis.kind, "app");
  assert.deepEqual(install.methods.map((method) => [method.id, method.driver, [...method.requires]]), [["native", "js", []]]);
  await access(new URL(`../${install.methods[0].entry}`, import.meta.url));
  assert.deepEqual(install.ports.map((port) => port.name), ["web"], "no database port");
  assert.deepEqual(install.directories, [{ name: "site", path: "site" }]);
  for (const software of install.software) {
    assert.match(software.sha256, /^[0-9a-f]{64}$/);
    assert.match(software.archive, /^https:\/\/download\.dokuwiki\.org\/src\/dokuwiki\/dokuwiki-[\d-]+[a-z]?\.tgz$/);
  }
  assert.equal(manifest.zelavis.project.managed.adminTitle, "DokuWiki");
  assert.match(manifest.zelavis.project.managed.adminPath, /^\/[A-Za-z0-9._\/-]*$/, "the Platform accepts a plain absolute path only");
});

test("PHP and the web server are the recipe's own: pinned builds for every platform, not the host's", () => {
  assert.deepEqual(install.runtimes.map((runtime) => runtime.command), ["php", "php-fpm", "caddy"]);
  for (const runtime of install.runtimes) {
    assert.match(runtime.version, runtime.command === "caddy" ? /^2\.\d+\.\d+$/ : /^8\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(runtime.downloads).sort(), ["linux-aarch64", "linux-x86_64", "macos-aarch64", "macos-x86_64"]);
    for (const download of Object.values(runtime.downloads)) assert.match(download.sha256, /^[0-9a-f]{64}$/);
  }
});

test("its runtime is the Platform's recipe runtime", () => {
  const agent = { start: async () => { throw new Error("not started"); } };
  const driver = createProjectRuntime({ directory: "/tmp/zv-dw-test", packageDirectory: new URL("..", import.meta.url).pathname, agent, options: {} });
  assert.equal(driver.name, "native-dokuwiki");
  assert.match(driver.capabilities({}).description, /DokuWiki/);
});

const context = (overrides = {}) => ({
  projectId: "p1", hostname: "localhost", software: install.software[0], method: install.methods[0], config: {},
  ports: { web: 18080 },
  directories: { root: "/srv/p1/.zelavis/server", sockets: "/run/zv-abc", named: { site: "/srv/p1/app/site" } },
  account: { user: "www-data", group: "www-data", switchUser: false },
  ...overrides,
});

function fakeHost() {
  const files = new Map();
  const calls = { writes: new Map(), runs: [], downloads: [], extracts: [], removed: [] };
  const host = {
    files: {
      read: (path) => Effect.succeed(files.get(path) ?? ""),
      exists: (path) => Effect.succeed(files.has(path)),
      write: (path, content) => Effect.sync(() => { files.set(path, "written"); calls.writes.set(path, content); }),
      mkdir: (path) => Effect.sync(() => { files.set(path, "dir"); }),
      remove: (path) => Effect.sync(() => { calls.removed.push(path); for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key); }),
    },
    download: (input) => Effect.sync(() => { calls.downloads.push(input); files.set(input.destination, "archive"); }),
    extract: (archive, destination, options) => Effect.sync(() => { calls.extracts.push({ archive, destination, options }); files.set(`${destination}/doku.php`, "x"); }),
    run: (input) => Effect.sync(() => {
      calls.runs.push(input);
      if (input.command === "php" && input.args[0] === "-r" && input.args[1].includes("extension_loaded")) return { code: 0, stdout: "[]", stderr: "" };
      if (input.command === "php") return { code: 0, stdout: "8.4.1", stderr: "" };
      if (input.command === "php-fpm" && input.args[0] === "-v") return { code: 0, stdout: "PHP 8.4.1 (fpm-fcgi)", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }),
    secret: () => Effect.die("DokuWiki has no credentials to hold"),
    progress: () => Effect.void,
  };
  return { host, calls, files };
}
const runInstall = (fake, ctx = context()) => Effect.runPromise(recipe.install(ctx).pipe(Effect.provideService(RecipeHost, fake.host)));

test("start is two processes, PHP-FPM then Caddy, both reloadable, within the manifest's names", () => {
  const plan = Effect.runSync(recipe.start(context()));
  const checked = parseProcessPlan(plan, { commands: ["caddy", "php", "php-fpm"], ports: ["web"], directories: ["/srv/p1/.zelavis/server", "/srv/p1/app", "/run/zv-abc"] });
  assert.deepEqual(checked.processes.map((process) => [process.name, [...process.dependsOn]]), [["php-fpm", []], ["caddy", ["php-fpm"]]]);
  assert.deepEqual(checked.processes.map((process) => process.update), [{ strategy: "reload", signal: "SIGUSR2" }, { strategy: "reload", signal: "SIGUSR1" }]);
});

test("install downloads the pinned release into the named site directory, holds no secret, and validates both configurations", async () => {
  const fake = fakeHost();
  await runInstall(fake);
  assert.deepEqual(fake.calls.downloads.map((d) => [d.url, d.sha256, d.destination]), [[install.software[0].archive, install.software[0].sha256, "dl/dokuwiki.tar.gz"]]);
  assert.deepEqual(fake.calls.extracts, [{ archive: "dl/dokuwiki.tar.gz", destination: "/srv/p1/app/site", options: { stripTopLevel: true } }]);
  const caddy = fake.calls.writes.get("Caddyfile");
  assert.match(caddy, /index doku\.php/);
  assert.match(caddy, /respond @denied 403/);
  assert.ok(fake.calls.runs.some((call) => call.command === "caddy" && call.args[0] === "validate"));
  assert.ok(fake.calls.runs.some((call) => call.command === "php-fpm" && call.args[0] === "-tt"));
});

test("the site is wherever the Project has it, and an install that finds it does not download again", async () => {
  const named = { site: "/srv/p1/app/web/wiki" };
  const fake = fakeHost();
  await runInstall(fake, context({ directories: { root: "/srv/p1/.zelavis/server", sockets: "/run/zv-abc", named } }));
  assert.deepEqual(fake.calls.extracts.map((e) => e.destination), ["/srv/p1/app/web/wiki"]);
  assert.match(fake.calls.writes.get("Caddyfile"), /root \* "\/srv\/p1\/app\/web\/wiki"/);
  await runInstall(fake, context({ directories: { root: "/srv/p1/.zelavis/server", sockets: "/run/zv-abc", named } }));
  assert.equal(fake.calls.downloads.length, 1, "nothing is downloaded twice");
});

test("install refuses what it cannot run, and says why", async () => {
  const oldPhp = fakeHost();
  const run = oldPhp.host.run;
  oldPhp.host.run = (input) => input.command === "php" && input.args[0] === "-r" && !input.args[1].includes("extension_loaded")
    ? Effect.succeed({ code: 0, stdout: "8.1.9", stderr: "" }) : run(input);
  await assert.rejects(runInstall(oldPhp), /PHP CLI and PHP-FPM 8\.2 or newer/);
  const noExtension = fakeHost();
  const run2 = noExtension.host.run;
  noExtension.host.run = (input) => input.command === "php" && input.args[1]?.includes?.("extension_loaded") ? Effect.succeed({ code: 0, stdout: '["mbstring"]', stderr: "" }) : run2(input);
  await assert.rejects(runInstall(noExtension), /missing required PHP extensions: mbstring/);
});
