import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";

import { initializeMariaDb, mariaDbProcess, parseProcessPlan, releaseMariaDb, requireMariaDb } from "../dist/core/recipe/index.js";

const IMAGE = `mariadb@sha256:${"a".repeat(64)}`;
const spec = { name: "app", user: "app", data: { absolute: "/srv/p/app/db" } };
const context = (container) => ({
  projectId: "p1", hostname: "localhost", software: {}, config: {}, ports: { web: 18080, db: 13306 },
  method: container ? { id: "container", driver: "js", requires: ["docker"], containers: { database: IMAGE } } : { id: "native", driver: "js", requires: [] },
  directories: { root: "/srv/p/app", sockets: "/run/zv", named: { db: "/srv/p/app/db" } },
  account: { user: "u", group: "g", uid: 1001, gid: 1002, switchUser: false },
});

function fakeHost(answers = {}) {
  const calls = { runs: [], writes: new Map(), dirs: [], removed: [], secrets: [] };
  const files = new Set();
  const host = {
    files: {
      read: () => Effect.succeed(""), exists: (path) => Effect.succeed(files.has(path)),
      write: (path, content) => Effect.sync(() => { files.add(path); calls.writes.set(path, content); }),
      mkdir: (path) => Effect.sync(() => { calls.dirs.push(path); }),
      remove: (path) => Effect.sync(() => { calls.removed.push(path); }),
    },
    run: (input) => Effect.sync(() => { calls.runs.push(input); return answers[input.command] ?? { code: 0, stdout: "mariadbd  Ver 11.4.2-MariaDB", stderr: "" }; }),
    secret: (name) => Effect.sync(() => { calls.secrets.push(name); return { secret: name }; }),
    progress: () => Effect.void,
  };
  return { host, calls };
}
const direct = (effect) => Effect.runPromise(effect);

test("the native method runs the database program with its own data directory and port", () => {
  const process = mariaDbProcess(context(false), spec);
  assert.equal(process.command, "mariadbd");
  assert.ok(process.args.includes("--datadir=/srv/p/app/db") && process.args.includes("--port=13306"));
  parseProcessPlan({ processes: [process] }, { commands: ["mariadbd"], ports: ["db"], directories: ["/srv/p/app", "/run/zv"] });
});

test("the container method runs the pinned image as the Project's account, published on loopback only, with the password kept out of the arguments", () => {
  const process = mariaDbProcess(context(true), spec);
  assert.equal(process.command, "docker");
  const args = process.args;
  assert.deepEqual(args.slice(0, 3), ["run", "--rm", "--name"]);
  assert.ok(args.includes("1001:1002"));
  assert.ok(args.includes("127.0.0.1:13306:3306"), "only the loopback address is published");
  assert.ok(args.includes("/srv/p/app/db:/var/lib/mysql"));
  assert.ok(args.includes(IMAGE));
  assert.ok(args.includes("MARIADB_PASSWORD") && !args.some((arg) => typeof arg === "string" && arg.startsWith("MARIADB_PASSWORD=")), "the secret is inherited, not written");
  assert.deepEqual(process.env, { MARIADB_PASSWORD: { secret: "db-password" } });
  parseProcessPlan({ processes: [process] }, { commands: ["docker"], ports: ["db"], directories: ["/srv/p/app", "/run/zv"] });
});

test("the container method refuses an account it cannot name numerically", () => {
  const ctx = context(true);
  ctx.account = { user: "u", group: "g", switchUser: false };
  assert.throws(() => mariaDbProcess(ctx, spec), /numerically/);
});

test("initializing pulls the image and prepares the data directory for the container; the native method runs the installer", async () => {
  const container = fakeHost();
  await direct(initializeMariaDb(container.host, context(true), spec));
  assert.deepEqual(container.calls.runs.map((call) => [call.command, call.args[0]]), [["docker", "pull"]]);
  assert.deepEqual(container.calls.dirs, ["/srv/p/app/db"]);
  assert.deepEqual(container.calls.secrets, ["db-password"]);
  assert.equal(container.calls.writes.size, 0, "the image creates the database and account itself");

  const native = fakeHost();
  await direct(initializeMariaDb(native.host, context(false), spec));
  assert.deepEqual(native.calls.runs.map((call) => call.command), ["mariadb-install-db"]);
  assert.ok(native.calls.writes.has("/srv/p/app/db/.zelavis-initialized"));

  const failing = fakeHost({ docker: { code: 1, stdout: "", stderr: "denied" } });
  await assert.rejects(direct(initializeMariaDb(failing.host, context(true), spec)), /image could not be fetched/);
});

test("the container method refuses a stopped engine; the native method refuses an old server", async () => {
  await assert.rejects(direct(requireMariaDb(fakeHost({ docker: { code: 1, stdout: "", stderr: "" } }).host, context(true), {})), /not running/);
  await direct(requireMariaDb(fakeHost({ docker: { code: 0, stdout: "29.1.3", stderr: "" } }).host, context(true), {}));
  await assert.rejects(direct(requireMariaDb(fakeHost({ mariadbd: { code: 0, stdout: "mariadbd Ver 10.3.1-MariaDB", stderr: "" } }).host, context(false), { minimum: [10, 6] })), /needs MariaDB 10\.6/);
});

test("releasing removes a leftover container by name for the container method and does nothing for the native one", async () => {
  const container = fakeHost({ docker: { code: 1, stdout: "", stderr: "No such container" } });
  await direct(releaseMariaDb(container.host, context(true)));
  assert.deepEqual(container.calls.runs.map((call) => call.args), [["rm", "--force", "zv-p1-database"]], "a missing container is the normal answer");
  const native = fakeHost();
  await direct(releaseMariaDb(native.host, context(false)));
  assert.deepEqual(native.calls.runs, []);
});

test("the database waits for the server's greeting, not only an open port", () => {
  assert.equal(mariaDbProcess(context(true), spec).readiness.greeting, true);
  assert.equal(mariaDbProcess(context(false), spec).readiness.greeting, true);
});

test("a greeting probe tells a proxy that merely accepts from a server that speaks", async (t) => {
  const { createServer } = await import("node:net");
  const { loopbackPortAccepts } = await import("../dist/adapters/_loopback-probe.js");
  const listen = (handler) => new Promise((resolve) => { const server = createServer(handler); server.listen(0, "127.0.0.1", () => resolve(server)); });
  const proxy = await listen((socket) => socket.end());
  const mysql = await listen((socket) => { socket.write("\x4a\x00\x00\x00\x0a"); socket.end(); });
  t.after(() => { proxy.close(); mysql.close(); });
  assert.equal(await Effect.runPromise(loopbackPortAccepts(proxy.address().port)), true, "a plain probe is satisfied by an open port");
  assert.equal(await Effect.runPromise(loopbackPortAccepts(proxy.address().port, { greeting: true })), false, "a port that closes without a word is not a server");
  assert.equal(await Effect.runPromise(loopbackPortAccepts(mysql.address().port, { greeting: true })), true);
});
