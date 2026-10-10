/**
 * Qualify the TYPO3 recipe on the disposable Debian/systemd installation the WordPress harness prepared:
 * the values TYPO3's installer asks for are read from the Project (the password only revealed, audited),
 * used to run TYPO3's own setup command, and the installed site and backend serve; then the recipe of
 * the running Project is upgraded under traffic.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, get as httpGet } from "node:http";
import { pathToFileURL } from "node:url";
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1") throw new Error("Run through the provisioning container on a disposable container.");
await access("/.dockerenv");
const platform = process.env.ZELAVIS_QUALIFICATION_PLATFORM ?? "/opt/zelavis/current/platform";
const phase = process.argv[2];
const baseUrl = "http://127.0.0.1:3000";
const id = "qualification-typo3";
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
const installer = (args, options, hide = []) => {
  try { return execFileSync("php", args, { ...options, stdio: "pipe", encoding: "utf8" }); }
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
  assert.ok(text.includes("client_max_body_size"), "the fixture's anchor line is still in the recipe");
  return text.replace("client_max_body_size 64m;", 'client_max_body_size 64m;\n  add_header X-Recipe "historical" always;');
};

if (phase === "create") {
  assert.notEqual(process.getuid(), 0, "the qualification client and Project must be unprivileged");
  const recipes = await client.projects.recipes();
  assert.deepEqual(recipes.find((recipe) => recipe.name === "@zelavis/typo3").hostPackages, ["php-stack", "mariadb-server"]);
  let project = await client.projects.create({ id, name: "Qualification TYPO3", recipeName: "@zelavis/typo3", installHostPackages: true });
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  const first = await ask(`${project.runtime.url}/`);
  assert.ok(first.status === 200 || first.status === 302, `served ${first.status}`);
  assert.match(first.body + String(first.location), /install|TYPO3/);

  // What TYPO3's installer asks for, from the Project.
  const listed = await client.projects.setup(id);
  assert.deepEqual(listed.map((entry) => entry.id), ["db-driver", "db-host", "db-port", "db-name", "db-user", "db-password"]);
  assert.equal(listed.find((entry) => entry.id === "db-password").value, undefined, "the password is not listed");
  const values = Object.fromEntries((await client.projects.revealSetup(id)).map((entry) => [entry.id, entry.value]));
  assert.ok(values["db-password"] && values["db-password"].length >= 16);
  // They really are the credentials of the Project's database.
  const connect = execFileSync("php", ["-r", 'mysqli_report(MYSQLI_REPORT_OFF); [$host, $port] = explode(":", $argv[1]); $link = new mysqli($host, $argv[2], $argv[3], $argv[4], (int) $port); echo $link->connect_errno === 0 ? "connected" : "refused: " . $link->connect_error;', "--", `${values["db-host"]}:${values["db-port"]}`, values["db-user"], values["db-password"], values["db-name"]], { encoding: "utf8" });
  assert.equal(connect, "connected");
  console.log("PASS: TYPO3's installer values come from the Project, the password only on request, and they open its database.");

  // TYPO3's own setup command with exactly those values.
  const site = `${directory}/app/site`;
  const adminPassword = `Adm!${randomBytes(12).toString("hex")}`;
  installer(["-d", "memory_limit=512M", `${site}/typo3/sysext/core/bin/typo3`, "setup", "--no-interaction", `--driver=${values["db-driver"].toLowerCase()}`, `--host=${values["db-host"]}`,
    `--port=${values["db-port"]}`, `--dbname=${values["db-name"]}`, `--username=${values["db-user"]}`, `--password=${values["db-password"]}`, "--admin-username=admin",
    `--admin-user-password=${adminPassword}`, "--admin-email=admin@example.test", "--project-name=Qualification", `--create-site=${project.runtime.url}/`, "--server-type=other", "--force"],
    { cwd: site, env: { ...process.env, PWD: site }, timeout: 300_000 }, [values["db-password"], adminPassword]);
  // The command-line setup leaves the installer marker (the web installer removes it): an operator removes it.
  assert.ok(existsSync(`${site}/typo3conf/system/settings.php`), "TYPO3 wrote its configuration");
  await rm(`${site}/FIRST_INSTALL`, { force: true });
  const front = await ask(`${project.runtime.url}/`);
  if (front.status >= 500) {
    // What the application and the servers logged, since TYPO3 answers a bare error page.
    const tails = [];
    for (const file of [`${directory}/app/run/php-errors.log`, `${directory}/app/run/nginx-error.log`, `${directory}/app/run/php-fpm.log`]) {
      tails.push(`${file}:\n${(await readFile(file, "utf8").catch(() => "(unreadable)")).slice(-1200)}`);
    }
    const logs = execFileSync("sh", ["-c", `tail -n 8 ${site}/typo3temp/var/log/*.log 2>/dev/null | cut -c1-500`], { encoding: "utf8" });
    throw new Error(`The front page answered ${front.status}.\n${tails.join("\n")}\nTYPO3:\n${logs}`);
  }
  const backend = await ask(`${project.runtime.url}/typo3/`);
  assert.ok(backend.status === 200 || backend.status === 302, `backend ${backend.status}`);
  assert.match(backend.body + String(backend.location), /TYPO3|login/i);
  console.log("PASS: TYPO3 set up with the Project's values and serves its site and backend login.");
  project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
} else if (phase === "stop") {
  const project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
  console.log("PASS: TYPO3 stopped for the next live-upgrade round.");
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
  console.log("PASS: historical TYPO3 recipe prepared on a stopped Project.");
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
  const current = (await client.projects.recipes()).find((recipe) => recipe.name === "@zelavis/typo3").version;
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  assert.equal(project.recipe.version, current);
  assert.equal(failures, 0, `no request failed during the live recipe upgrade: ${JSON.stringify(failed.slice(0, 5))}`);
  assert.ok(served > 20, `served ${served}`);
  assert.deepEqual([...headers].sort(), ["historical", null].sort(), `responses switched to the new web configuration: saw ${JSON.stringify([...headers])}`);
  assert.deepEqual(await pids(), before, "Nginx, PHP-FPM and MariaDB are the same processes");
  assert.equal((await ask(`${project.runtime.url}/`)).header, null);
  console.log(`PASS: running TYPO3 upgraded its recipe live: ${served} requests, none failed, same Nginx/PHP-FPM/MariaDB processes.`);
} else {
  throw new Error(`Unknown phase "${phase}".`);
}
