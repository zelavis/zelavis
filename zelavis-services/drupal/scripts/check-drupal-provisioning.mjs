/**
 * Qualify the Drupal recipe on the disposable Debian/systemd installation the WordPress harness prepared:
 * the values Drupal's installer asks for are read from the Project (the password only revealed, audited),
 * used to run Drupal's own installer, and the installed site serves; then the recipe of the running
 * Project is upgraded under traffic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, get as httpGet } from "node:http";
import { pathToFileURL } from "node:url";
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1") throw new Error("Run through the provisioning container on a disposable container.");
await access("/.dockerenv");
const platform = process.env.ZELAVIS_QUALIFICATION_PLATFORM ?? "/opt/zelavis/current/platform";
const phase = process.argv[2];
const baseUrl = "http://127.0.0.1:3000";
const id = "qualification-drupal";
const directory = `/var/lib/zelavis/projects/${id}`;
const { createZelavisClient } = await import(pathToFileURL(`${platform}/dist/sdk/fetch.js`).href);
const cookie = await readFile("/var/lib/zelavis/qualification-session", "utf8");
const client = createZelavisClient({ baseUrl, headers: { cookie, origin: baseUrl } });
// A failed call says which one it was.
for (const [method, call] of Object.entries(client.projects)) {
  client.projects[method] = async (...args) => {
    try { return await call(...args); } catch (error) { if (error instanceof Error) {
        const raw = error.response && !error.response.bodyUsed ? await error.response.clone().text().catch(() => "") : "";
        error.message = `projects.${method}: ${error.message} ${JSON.stringify(error.body ?? {})} [${error.response?.status} ${error.response?.headers?.get?.("content-type")}] ${raw.slice(0, 300)}`;
      }
      throw error; }
  };
}

/** Runs the application's own installer; a failure reports what the tool said, with the generated values removed. */
/** The PHP this Project brought with it (set when the Project exists). */
let phpBinary;
const installer = (args, options, hide = []) => {
  try { return execFileSync(phpBinary, args, { ...options, stdio: "pipe", encoding: "utf8" }); }
  catch (error) {
    let said = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    for (const secret of hide) said = said.split(secret).join("[hidden]");
    throw new Error(`The installer failed (${error.status ?? error.signal}):\n${said.slice(-2500)}`);
  }
};

const oneConnection = new Agent({ keepAlive: false });
const ask = (url) => new Promise((resolve, reject) => {
  httpGet(url, { agent: oneConnection }, (reply) => {
    let body = "";
    reply.setEncoding("utf8");
    reply.on("data", (chunk) => { body += chunk; });
    reply.on("end", () => resolve({ status: reply.statusCode, body, header: reply.headers["x-recipe"] ?? null, location: reply.headers.location }));
    reply.on("error", reject);
  }).on("error", reject);
});
const header = (text) => {
  assert.ok(text.includes("request_body {"), "the fixture's anchor line is still in the recipe");
  return text.replace("request_body {", 'header X-Recipe "historical"\n\trequest_body {');
};

if (phase === "create") {
  assert.notEqual(process.getuid(), 0, "the qualification client and Project must be unprivileged");
  const recipes = await client.projects.recipes();
  assert.deepEqual(recipes.find((recipe) => recipe.name === "@zelavis/drupal").hostPackages, ["mariadb-server"]);
  let project = await client.projects.create({ id, name: "Qualification Drupal", recipeName: "@zelavis/drupal" });
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  phpBinary = JSON.parse(await readFile(`${directory}/.zelavis/recipe-state.json`, "utf8")).commands.php;
  assert.match(phpBinary, /^\/var\/lib\/zelavis\/runtimes\/[0-9a-f]{64}\/php$/, "the PHP is the recipe's own, in the Platform's store");
  const commands = JSON.parse(await readFile(`${directory}/.zelavis/recipe-state.json`, "utf8")).commands;
  // MariaDB is only built for Linux x86_64; on other machines the host's is used.
  if (process.arch === "x64") for (const name of ["mariadbd", "mariadb-install-db", "mariadb"]) assert.match(commands[name], /^\/var\/lib\/zelavis\/runtimes\/[0-9a-f]{64}\/mariadb-[\d.]+-linux-systemd-x86_64\//, `${name} is the recipe's own MariaDB, not the host's`);
  const first = await ask(`${project.runtime.url}/`);
  assert.ok(first.status === 200 || first.status === 302, `served ${first.status}`);
  assert.match(first.body + String(first.location), /install|Drupal/i);

  // What Drupal's installer asks for, from the Project.
  const listed = await client.projects.setup(id);
  assert.deepEqual(listed.map((entry) => entry.id), ["db-type", "db-name", "db-user", "db-password", "db-host", "db-port"]);
  assert.equal(listed.find((entry) => entry.id === "db-password").value, undefined, "the password is not listed");
  const values = Object.fromEntries((await client.projects.revealSetup(id)).map((entry) => [entry.id, entry.value]));
  assert.ok(values["db-password"] && values["db-password"].length >= 16);
  // They really are the credentials of the Project's database.
  const connect = execFileSync(phpBinary, ["-r", 'mysqli_report(MYSQLI_REPORT_OFF); $link = new mysqli($argv[1], $argv[2], $argv[3], $argv[4], (int) $argv[5]); echo $link->connect_errno === 0 ? "connected" : "refused: " . $link->connect_error;', "--", values["db-host"], values["db-user"], values["db-password"], values["db-name"], values["db-port"]], { encoding: "utf8" });
  assert.equal(connect, "connected");
  console.log("PASS: Drupal's installer values come from the Project, the password only on request, and they open its database.");

  // Drupal's own installer (the code its web installer runs) with exactly those values.
  const site = `${directory}/app/site`;
  const adminPassword = `Adm-${randomBytes(12).toString("hex")}`;
  const script = `${directory}/app/tmp/install.php`;
  await writeFile(script, `<?php
chdir($argv[1]);
$loader = require 'autoload.php';
require_once 'core/includes/install.core.inc';
$driver = 'Drupal\\mysql\\Driver\\Database\\mysql';
install_drupal($loader, [
  'interactive' => FALSE, 'site_path' => 'sites/default',
  'parameters' => ['profile' => 'standard', 'langcode' => 'en'],
  'forms' => [
    'install_settings_form' => ['driver' => $driver, $driver => ['database' => getenv('DB_NAME'), 'username' => getenv('DB_USER'), 'password' => getenv('DB_PASSWORD'), 'host' => getenv('DB_HOST'), 'port' => getenv('DB_PORT')]],
    'install_configure_form' => ['site_name' => 'Qualification', 'site_mail' => 'site@example.test', 'account' => ['name' => 'admin', 'mail' => 'admin@example.test', 'pass' => ['pass1' => getenv('ADMIN_PASSWORD'), 'pass2' => getenv('ADMIN_PASSWORD')]], 'enable_update_status_emails' => NULL],
  ],
]);
echo "installed";
`, { mode: 0o600 });
  installer(["-d", "memory_limit=512M", script, site], { cwd: site, env: { ...process.env, PWD: site, DB_NAME: values["db-name"], DB_USER: values["db-user"], DB_PASSWORD: values["db-password"], DB_HOST: values["db-host"], DB_PORT: values["db-port"], ADMIN_PASSWORD: adminPassword }, timeout: 480_000 }, [values["db-password"], adminPassword]);
  await rm(script, { force: true });
  const front = await ask(`${project.runtime.url}/`);
  assert.equal(front.status, 200, front.body.slice(0, 300));
  assert.match(front.body, /Qualification/);
  const login = await ask(`${project.runtime.url}/user/login`);
  assert.equal(login.status, 200);
  assert.match(login.body, /Log in|Username/i);
  const hidden = await ask(`${project.runtime.url}/sites/default/settings.php`);
  assert.equal(hidden.status, 403, "settings.php is never served");
  console.log("PASS: Drupal installed with the Project's values and serves its site and login.");
  project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
} else if (phase === "stop") {
  const project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
  console.log("PASS: Drupal stopped for the next live-upgrade round.");
} else if (phase === "seed") {
  // A controlled historical recipe on a stopped Project and a stopped Platform; not a released version.
  assert.notEqual(execFileSync("sh", ["-c", "systemctl is-active zelavis.service 2>/dev/null || true"], { encoding: "utf8" }).trim(), "active");
  const { createLocalSqliteSystemStore } = await import(pathToFileURL(`${platform}/dist/adapters/_sqlite-system-store.js`).href);
  const { digestArtifactDirectory } = await import(pathToFileURL(`${platform}/dist/adapters/_recipe-artifact.js`).href);
  const frozen = `${directory}/.zelavis/recipe/package`;
  const manifest = JSON.parse(await readFile(`${frozen}/package.json`, "utf8"));
  manifest.version = "0.0.0-qualification";
  await writeFile(`${frozen}/package.json`, JSON.stringify(manifest));
  await writeFile(`${frozen}/dist/recipe.js`, header(await readFile(`${frozen}/dist/recipe.js`, "utf8")));
  await writeFile(`${directory}/app/Caddyfile`, header(await readFile(`${directory}/app/Caddyfile`, "utf8")));
  const descriptor = JSON.parse(await readFile(`${directory}/project.json`, "utf8"));
  descriptor.recipe = { ...descriptor.recipe, version: manifest.version, artifact: { digest: await digestArtifactDirectory(frozen) } };
  await writeFile(`${directory}/project.json`, JSON.stringify(descriptor));
  const store = createLocalSqliteSystemStore({ filename: "/var/lib/zelavis/system/zelavis.sqlite" });
  try {
    const record = await store.get("projects", id);
    assert.equal(record.value.desiredState, "stopped");
    await store.set("projects", id, { ...record.value, recipe: descriptor.recipe });
  } finally { await store.close(); }
  console.log("PASS: historical Drupal recipe prepared on a stopped Project.");
} else if (phase === "live-upgrade") {
  let project = await client.projects.get(id);
  assert.equal(project.recipeStatus.state, "upgradeAvailable");
  project = await client.projects.start(id);
  assert.equal(project.recipe.version, "0.0.0-qualification");
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  const run = `${directory}/app/run`;
  const pids = async () => Object.fromEntries(await Promise.all(["caddy", "php-fpm", "mariadb"].map(async (name) => [name, (await readFile(`${run}/${name}.pid`, "utf8")).trim()])));
  const before = await pids();
  assert.equal((await ask(`${project.runtime.url}/`)).header, "historical");
  let stop = false, failures = 0, served = 0; const headers = new Set(); const failed = [];
  const traffic = (async () => {
    while (!stop) {
      try {
        const reply = await ask(`${project.runtime.url}/`);
        if (reply.status >= 500) { failures += 1; failed.push(`${reply.status} ${reply.body.slice(0, 120)}`); } else served += 1;
        headers.add(reply.header);
      } catch (error) { failures += 1; failed.push(String(error?.code ?? error)); }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 500));
  project = await client.projects.upgrade(id, {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  stop = true; await traffic;
  const current = (await client.projects.recipes()).find((recipe) => recipe.name === "@zelavis/drupal").version;
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  assert.equal(project.recipe.version, current);
  assert.equal(failures, 0, `no request failed during the live recipe upgrade: ${JSON.stringify(failed.slice(0, 5))}`);
  assert.ok(served > 20, `served ${served}`);
  assert.deepEqual([...headers].sort(), ["historical", null].sort(), `responses switched to the new web configuration: saw ${JSON.stringify([...headers])}`);
  assert.deepEqual(await pids(), before, "Caddy, PHP-FPM and MariaDB are the same processes");
  assert.equal((await ask(`${project.runtime.url}/`)).header, null);
  console.log(`PASS: running Drupal upgraded its recipe live: ${served} requests, none failed, same Caddy/PHP-FPM/MariaDB processes.`);
} else {
  throw new Error(`Unknown phase "${phase}".`);
}
