/**
 * Qualify the DokuWiki recipe, the second managed recipe, on the disposable Debian/systemd installation
 * the WordPress harness prepared: it creates a Project, serves the wiki, and then upgrades the recipe of a
 * running Project under traffic (only Nginx's configuration differs, so nothing may restart).
 * Run through zelavis-services/wordpress/scripts/wordpress-provisioning-container.sh.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { Agent, get as httpGet } from "node:http";
import { pathToFileURL } from "node:url";
if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1") throw new Error("Run through the provisioning container on a disposable container.");
await access("/.dockerenv");
const platform = process.env.ZELAVIS_QUALIFICATION_PLATFORM ?? "/opt/zelavis/current/platform";
const phase = process.argv[2];
const baseUrl = "http://127.0.0.1:3000";
const id = "qualification-dokuwiki";
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
  assert.deepEqual(recipes.find((recipe) => recipe.name === "@zelavis/dokuwiki").hostPackages, ["php-stack"]);
  // Run before anything installed the WordPress stack: this set alone provides the web tier and no database.
  await assert.rejects(access("/usr/sbin/nginx"), { code: "ENOENT" });
  let project = await client.projects.create({ id, name: "Qualification DokuWiki", recipeName: "@zelavis/dokuwiki", installHostPackages: true });
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  await access("/usr/sbin/nginx");
  await assert.rejects(access("/usr/sbin/mariadbd"), { code: "ENOENT" }, "the php-stack set installs no database");
  const page = await ask(`${project.runtime.url}/`);
  assert.ok(page.status === 200 || page.status === 302, `served ${page.status}`);
  const installer = await ask(`${project.runtime.url}/install.php`);
  assert.equal(installer.status, 200);
  assert.match(installer.body, /DokuWiki/);
  // Nothing of its configuration or data is served.
  assert.equal((await ask(`${project.runtime.url}/conf/dokuwiki.php`)).status, 403);
  assert.equal((await ask(`${project.runtime.url}/data/`)).status, 403);
  console.log("PASS: DokuWiki Project created, running, serving its installer, and refusing conf/ and data/.");
  project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
} else if (phase === "stop") {
  const project = await client.projects.stop(id);
  assert.equal(project.runtime.status, "stopped");
  console.log("PASS: DokuWiki stopped for the next live-upgrade round.");
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
  console.log("PASS: historical DokuWiki recipe prepared on a stopped Project.");
} else if (phase === "live-upgrade") {
  let project = await client.projects.get(id);
  assert.equal(project.recipeStatus.state, "upgradeAvailable");
  project = await client.projects.start(id);
  assert.equal(project.recipe.version, "0.0.0-qualification");
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  const run = `${directory}/app/run`;
  const pids = async () => Object.fromEntries(await Promise.all(["nginx", "php-fpm"].map(async (name) => [name, (await readFile(`${run}/${name}.pid`, "utf8")).trim()])));
  const before = await pids();
  assert.equal((await ask(`${project.runtime.url}/install.php`)).header, "historical");
  let stop = false, failures = 0, served = 0; const headers = new Set(); const failed = [];
  const traffic = (async () => {
    while (!stop) {
      try {
        const reply = await ask(`${project.runtime.url}/install.php`);
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
  const current = (await client.projects.recipes()).find((recipe) => recipe.name === "@zelavis/dokuwiki").version;
  assert.equal(project.runtime.status, "running", JSON.stringify(project));
  assert.equal(project.recipe.version, current);
  assert.equal(failures, 0, `no request failed during the live recipe upgrade: ${JSON.stringify(failed.slice(0, 5))}`);
  assert.ok(served > 20, `served ${served}`);
  assert.deepEqual([...headers].sort(), ["historical", null].sort(), `responses switched to the new web configuration: saw ${JSON.stringify([...headers])}`);
  assert.deepEqual(await pids(), before, "Nginx and PHP-FPM are the same processes");
  assert.equal((await ask(`${project.runtime.url}/install.php`)).header, null);
  console.log(`PASS: running DokuWiki upgraded its recipe live: ${served} requests, none failed, same Nginx/PHP-FPM processes.`);
} else {
  throw new Error(`Unknown phase "${phase}".`);
}
