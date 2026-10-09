/**
 * Qualify the Joomla recipe on the disposable Debian/systemd installation the WordPress harness prepared:
 * the values Joomla's installer asks for are read from the Project (the password only revealed, audited),
 * used to run Joomla's own installer, and the installed site serves; then the recipe of the running
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
const id = "qualification-joomla";
const directory = `/var/lib/zelavis/projects/${id}`;
const { createZelavisClient } = await import(pathToFileURL(`${platform}/dist/sdk/fetch.js`).href);
const cookie = await readFile("/var/lib/zelavis/qualification-session", "utf8");
const client = createZelavisClient({ baseUrl, headers: { cookie, origin: baseUrl } });

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
  assert.ok(text.includes("client_max_body_size"), "the fixture's anchor line is still in the recipe");
  return text.replace("client_max_body_size 64m;", 'client_max_body_size 64m;\n  add_header X-Recipe "historical" always;');
};

if (phase === "create") {
  assert.notEqual(process.getuid(), 0, "the qualification client and Project must be unprivileged");
  const recipes = await client.projects.recipes();
  assert.deepEqual(recipes.find((recipe) => recipe.name === "@zelavis/joomla").hostPackages, ["php-stack", "mariadb-server"]);
  let project = await client.projects.create({ id, name: "Qualification Joomla", recipeName: "@zelavis/joomla", installHostPackages: true });
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  const first = await ask(`${project.runtime.url}/`);
  assert.ok(first.status === 200 || first.status === 302, `served ${first.status}`);
  assert.match(first.body + String(first.location), /installation|Joomla/);

  // What Joomla's installer asks for, from the Project.
  const listed = await client.projects.setup(id);
  assert.deepEqual(listed.map((entry) => entry.id), ["db-type", "db-host", "db-name", "db-user", "db-password"]);
  assert.equal(listed.find((entry) => entry.id === "db-password").value, undefined, "the password is not listed");
  const values = Object.fromEntries((await client.projects.revealSetup(id)).map((entry) => [entry.id, entry.value]));
  assert.ok(values["db-password"] && values["db-password"].length >= 16);
  // They really are the credentials of the Project's database.
  const connect = execFileSync("php", ["-r", 'mysqli_report(MYSQLI_REPORT_OFF); [$host, $port] = explode(":", $argv[1]); $link = new mysqli($host, $argv[2], $argv[3], $argv[4], (int) $port); echo $link->connect_errno === 0 ? "connected" : "refused: " . $link->connect_error;', "--", values["db-host"], values["db-user"], values["db-password"], values["db-name"]], { encoding: "utf8" });
  assert.equal(connect, "connected");
  console.log("PASS: Joomla's installer values come from the Project, the password only on request, and they open its database.");

  // Joomla's own installer with exactly those values.
  const site = `${directory}/app/site`;
  const adminPassword = `Adm-${randomBytes(12).toString("hex")}`;
  execFileSync("php", ["-d", "memory_limit=512M", "installation/joomla.php", "install", "--site-name=Qualification", "--admin-user=Administrator", "--admin-username=admin",
    `--admin-password=${adminPassword}`, "--admin-email=admin@example.test", `--db-type=${values["db-type"].toLowerCase()}`, `--db-host=${values["db-host"]}`,
    `--db-user=${values["db-user"]}`, `--db-pass=${values["db-password"]}`, `--db-name=${values["db-name"]}`, "--db-prefix=jos_", "--db-encryption=0"], { cwd: site, stdio: "pipe", timeout: 240_000 });
  await rm(`${site}/installation`, { recursive: true, force: true });
  const front = await ask(`${project.runtime.url}/`);
  assert.equal(front.status, 200, front.body.slice(0, 300));
  assert.match(front.body, /Qualification/);
  const admin = await ask(`${project.runtime.url}/administrator/`);
  assert.equal(admin.status, 200);
  assert.match(admin.body, /Joomla|login/i);
  console.log("PASS: Joomla installed with the Project's values and serves its site and administrator login.");
  project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
} else if (phase === "stop") {
  const project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
  console.log("PASS: Joomla stopped for the next live-upgrade round.");
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
  await writeFile(`${directory}/app/nginx.conf`, header(await readFile(`${directory}/app/nginx.conf`, "utf8")));
  const descriptor = JSON.parse(await readFile(`${directory}/project.json`, "utf8"));
  descriptor.recipe = { ...descriptor.recipe, version: manifest.version, artifact: { digest: await digestArtifactDirectory(frozen) } };
  await writeFile(`${directory}/project.json`, JSON.stringify(descriptor));
  const store = createLocalSqliteSystemStore({ filename: "/var/lib/zelavis/system/zelavis.sqlite" });
  try {
    const record = await store.get("projects", id);
    assert.equal(record.value.desiredState, "stopped");
    await store.set("projects", id, { ...record.value, recipe: descriptor.recipe });
  } finally { await store.close(); }
  console.log("PASS: historical Joomla recipe prepared on a stopped Project.");
} else if (phase === "live-upgrade") {
  let project = await client.projects.get(id);
  assert.equal(project.recipeStatus.state, "upgradeAvailable");
  project = await client.projects.start(id);
  assert.equal(project.recipe.version, "0.0.0-qualification");
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  const run = `${directory}/app/run`;
  const pids = async () => Object.fromEntries(await Promise.all(["nginx", "php-fpm", "mariadb"].map(async (name) => [name, (await readFile(`${run}/${name}.pid`, "utf8")).trim()])));
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
  const current = (await client.projects.recipes()).find((recipe) => recipe.name === "@zelavis/joomla").version;
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  assert.equal(project.recipe.version, current);
  assert.equal(failures, 0, `no request failed during the live recipe upgrade: ${JSON.stringify(failed.slice(0, 5))}`);
  assert.ok(served > 20, `served ${served}`);
  assert.deepEqual([...headers].sort(), ["historical", null].sort(), `responses switched to the new web configuration: saw ${JSON.stringify([...headers])}`);
  assert.deepEqual(await pids(), before, "Nginx, PHP-FPM and MariaDB are the same processes");
  assert.equal((await ask(`${project.runtime.url}/`)).header, null);
  console.log(`PASS: running Joomla upgraded its recipe live: ${served} requests, none failed, same Nginx/PHP-FPM/MariaDB processes.`);
} else {
  throw new Error(`Unknown phase "${phase}".`);
}
