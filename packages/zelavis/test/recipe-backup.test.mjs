// A managed app's own data in a backup: the directories its manifest marks `files` copied as they are, and what
// its recipe's `backup` phase makes of the ones it marks `recipe` (a database dump), staged by the Project's
// integration runtime as the `app` component while the app keeps serving, never writing inside `app/`. Then the
// run is drilled where it was made and on a machine holding nothing but the target and the recovery key.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Scope } from "effect";

import { createRecipeProjectRuntime, stageRecipeBackup } from "../dist/adapters/_recipe-project-runtime.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { materializeRecipeArtifact } from "../dist/adapters/_recipe-artifact.js";
import { dumpMariaDb, parseRecipeManifest } from "../dist/core/recipe/index.js";
import { backupsHost } from "../dist/db/node-backups.js";
import { InvalidBackup } from "../dist/db/errors.js";

const manifest = {
  contract: 2,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
  directories: [{ name: "site", path: "site", backup: "files" }, { name: "data", path: "data", backup: "recipe" }, { name: "cache", path: "cache" }],
};

const SERVER = `
const http = require("node:http");
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end("serving")).listen(Number(process.argv[2]), "127.0.0.1");
setInterval(() => {}, 1000);
`;

// Its "database" is a file in `data/`; the backup phase writes a consistent copy of it below the recipe's root,
// with a secret it generated, the way a dump reads a database with the application's own credentials.
const RECIPE = `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("server.js", ${JSON.stringify(SERVER)});
    yield* host.files.write(context.directories.named.site + "/index.html", "the site");
    yield* host.files.write(context.directories.named.data + "/table", "rows");
    yield* host.files.write(context.directories.named.cache + "/page", "cached");
    yield* host.secret("db-password");
  }),
  start: (context) => Effect.succeed({ processes: [
    { name: "web", command: "node", args: [context.directories.root + "/server.js", String(context.ports.web)], env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 4000 } },
  ] }),
  backup: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.remove("backup");
    yield* host.files.mkdir("backup");
    const rows = yield* host.files.read(context.directories.named.data + "/table");
    yield* host.files.write("backup/dump.sql", "-- dump of " + rows + "\\n-- Dump completed\\n");
    return { path: "backup" };
  }),
});
`;

async function managedProject(t) {
  const base = await mkdtemp(join(tmpdir(), "zv-recipe-backup-"));
  const directory = join(base, "projects");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, ".agent-processes") });
  const source = join(base, "recipe");
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@acme/managed", version: "1.0.0", zelavis: { kind: "app", project: { runtimeKinds: ["native"], install: manifest } } }));
  await writeFile(join(source, "dist", "recipe.mjs"), RECIPE);
  const id = "shop";
  const project = join(directory, id);
  const data = join(project, ".zelavis");
  await mkdir(data, { recursive: true });
  const { digest } = await materializeRecipeArtifact(source, data);
  const record = { id, name: id, kind: "managed", runtimeKind: "native", desiredState: "running", capabilities: {}, runtime: { driver: "x", status: "running" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recipe: { name: "@acme/managed", title: "Managed", version: "1.0.0", specifier: "@acme/managed", runtimeKinds: ["native"],
      install: { method: "native", driver: "js", requires: ["node"], software: "1.0" }, artifact: { digest } } };
  const driver = createRecipeProjectRuntime({ name: "recipe-test", description: "test", directory, packageDirectory: join(data, "recipe", "package"), agent: runner });
  t.after(async () => { await driver.close().catch(() => undefined); await runner.close(); await rm(base, { recursive: true, force: true }); });
  await driver.prepare(record, record.recipe);
  await driver.start(record);
  const state = JSON.parse(readFileSync(join(data, "recipe-state.json"), "utf8"));
  return { base, project, port: state.ports.web };
}

/** Every file below `root`, relative, with its inode and modification time: what "not written" means. */
async function snapshot(root) {
  const out = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const { ino, mtimeMs, size } = statSync(path);
    out[path.slice(root.length)] = { ino, mtimeMs, size };
  }
  return out;
}

test("a manifest directory says how it is backed up, and nothing else", () => {
  assert.equal(parseRecipeManifest(manifest).directories[1].backup, "recipe");
  assert.throws(() => parseRecipeManifest({ ...manifest, directories: [{ name: "site", path: "site", backup: "snapshot" }] }), /contract 1 or 2/);
});

test("a managed app's data is staged from its files and its recipe's backup phase, while it serves, without writing in app/", async (t) => {
  const { base, project, port } = await managedProject(t);
  const before = await snapshot(join(project, "app"));
  const into = join(base, "staged");
  await mkdir(into);

  const summary = await Effect.runPromise(stageRecipeBackup({ projectDirectory: project, into }));

  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "serving", "the app kept serving");
  assert.deepEqual(await snapshot(join(project, "app")), before, "nothing in app/ was written");
  assert.equal(await readFile(join(into, "files", "site", "index.html"), "utf8"), "the site");
  assert.equal(await readFile(join(into, "recipe", "dump.sql"), "utf8"), "-- dump of rows\n-- Dump completed\n");
  assert.deepEqual(await readdir(into), ["files", "recipe", "recipe.json"].sort(), "the raw data directory and the unmarked cache are not copied");
  assert.equal(summary.recipe, "@acme/managed@1.0.0");
  assert.deepEqual(summary.directories, [
    { name: "site", backup: "files", captured: "files/site" },
    { name: "data", backup: "recipe", captured: "recipe" },
    { name: "cache", captured: null },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(into, "recipe.json"), "utf8")).directories, summary.directories);
  assert.ok(!(await readdir(join(project, ".zelavis", "server"))).includes("backup"), "the recipe's staging is removed once copied");
});

test("an app run is drilled where it was made and on a machine that holds only the target and the recovery key", async (t) => {
  const { base, project } = await managedProject(t);
  const target = join(base, "offsite");
  const app = { name: "app", stage: (into) => stageRecipeBackup({ projectDirectory: project, into }).pipe(Effect.asVoid, Effect.mapError((error) => new InvalidBackup({ reason: error.message }))) };

  const scope = Effect.runSync(Scope.make());
  t.after(() => Effect.runPromise(Scope.close(scope, Effect.void)));
  const here = await Effect.runPromise(backupsHost({ directory: join(base, "backups-here"), components: [app], scope }));
  const schedule = await here.createSchedule({ name: "nightly", cron: "0 3 * * *", keep: 3, target: { kind: "directory", path: target } });
  const run = await here.runNow("nightly");
  assert.equal(run.status, "ok", run.error);

  const local = await here.drill("nightly", run.runId);
  assert.equal(local.drill.ok, true, local.drill.error);
  assert.deepEqual(local.drill.app, { recipe: "@acme/managed@1.0.0", captured: ["site", "data"], missing: ["cache"] });

  // Another machine: no schedule, no state, nothing of the first host's.
  const elsewhere = await Effect.runPromise(backupsHost({ directory: join(base, "backups-elsewhere"), components: [], scope }));
  const drilled = await elsewhere.drillFrom({ target: { kind: "directory", path: target }, schedule: "nightly", recoveryKey: schedule.recoveryKey });
  assert.equal(drilled.ok, true, drilled.error);
  assert.equal(drilled.runId, run.runId, "the newest finished run at the target");
  assert.deepEqual(drilled.app, local.drill.app);
  assert.ok(drilled.rtoMs >= 0 && drilled.rpoMs >= 0);
  assert.deepEqual(await elsewhere.runs(), [], "a drill from another host records nothing here");
  assert.deepEqual((await readdir(join(base, "backups-elsewhere", "drills")).catch(() => [])), [], "and keeps nothing");

  const wrongKey = await elsewhere.drillFrom({ target: { kind: "directory", path: target }, schedule: "nightly", recoveryKey: Buffer.alloc(32).toString("base64url") });
  assert.equal(wrongKey.ok, false);
  assert.match(wrongKey.error, /not the key this run was written with/);
  await assert.rejects(elsewhere.drillFrom({ target: { kind: "directory", path: target }, schedule: "weekly", recoveryKey: schedule.recoveryKey }), /no finished run of "weekly"/);
  await assert.rejects(elsewhere.drillFrom({ target: { kind: "directory", path: "relative" }, schedule: "nightly", recoveryKey: schedule.recoveryKey }), /absolute path/);
});

// The shared helper every MariaDB recipe's backup phase uses, against a host that records what it is asked to run.
function fakeHost(code = 0) {
  const runs = [];
  const host = {
    files: { read: () => Effect.succeed(""), exists: () => Effect.succeed(false), write: () => Effect.void, mkdir: () => Effect.void, remove: () => Effect.void },
    run: (input) => Effect.sync(() => { runs.push(input); return { code, stdout: "", stderr: code === 0 ? "" : "Access denied for user" }; }),
    secret: (name) => Effect.succeed({ secret: name }),
    progress: () => Effect.void,
  };
  return { host, runs };
}
const IMAGE = `mariadb@sha256:${"a".repeat(64)}`;
const context = (container) => ({
  projectId: "p1", hostname: "localhost", software: {}, config: {}, ports: { db: 13306 },
  method: container ? { id: "container", driver: "js", requires: ["docker"], containers: { database: IMAGE } } : { id: "native", driver: "js", requires: [] },
  directories: { root: "/srv/p/.zelavis/server", sockets: "/run/zv", named: { db: "/srv/p/app/db" } },
  account: { user: "u", group: "g", uid: 1001, gid: 1002, switchUser: false },
});
const spec = { name: "wordpress", user: "wordpress", data: { absolute: "/srv/p/app/db" } };

test("the database is dumped in one transaction by its own build, with the application's password in the environment", async () => {
  const { host, runs } = fakeHost();
  await Effect.runPromise(dumpMariaDb(host, context(false), spec, "backup"));
  assert.equal(runs.length, 1);
  const [dump] = runs;
  assert.equal(dump.command, "mariadb-dump");
  assert.ok(dump.args.includes("--single-transaction") && dump.args.includes("--port=13306") && dump.args.includes("--user=wordpress"));
  assert.ok(dump.args.includes("--result-file=/srv/p/.zelavis/server/backup/database.sql"), "written below the recipe's root, never in app/");
  assert.equal(dump.args.at(-1), "wordpress");
  assert.deepEqual(dump.env, { MYSQL_PWD: { secret: "db-password" } });
  assert.ok(!dump.args.some((arg) => typeof arg !== "string" || arg.includes("password")), "no password in the arguments");
});

test("in the container method the dump is the image's own, copied out of the container", async () => {
  const { host, runs } = fakeHost();
  await Effect.runPromise(dumpMariaDb(host, context(true), spec, "backup"));
  assert.deepEqual(runs.map((run) => run.args.slice(0, 2)), [["exec", "--env"], ["cp", "zv-p1-database:/tmp/zelavis-dump.sql"], ["exec", "zv-p1-database"]]);
  assert.ok(runs[0].args.includes("mariadb-dump") && runs[0].args.includes("--port=3306"));
  assert.equal(runs[1].args[2], "/srv/p/.zelavis/server/backup/database.sql");
});

test("a dump that fails is a failed backup, in the tool's own words", async () => {
  const { host } = fakeHost(2);
  const failure = await Effect.runPromise(Effect.flip(dumpMariaDb(host, context(false), spec, "backup")));
  assert.equal(failure.operation, "backup");
  assert.match(failure.message, /could not be dumped: Access denied/);
  const refused = await Effect.runPromise(Effect.flip(dumpMariaDb(host, context(false), spec, "../app")));
  assert.match(refused.message, /plain directory name/);
});
