// The plan controller against the real local Agent runner and real child processes: starting,
// readiness, failure cleanup, adoption, and above all reconciling a running plan to a new one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Fiber, PubSub } from "effect";

import { PlanHost, makePlanController } from "zelavis/recipe";
import { makeAgentPlanHost } from "../dist/adapters/_plan-host.js";
import { loopbackPortAccepts } from "../dist/adapters/_loopback-probe.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A service that records its life, answers HTTP with its pid and configuration, and reloads on SIGHUP/SIGUSR2. */
const SERVICE = `
const fs = require("node:fs"), http = require("node:http");
const [name, port, record, configFile, delay, exitAfter] = process.argv.slice(1);
const config = () => { try { return fs.readFileSync(configFile, "utf8"); } catch { return "none"; } };
let current = config();
const note = (what) => fs.appendFileSync(record, what + " " + name + " " + process.pid + " " + Date.now() + "\\n");
note("start");
const reload = () => { current = config(); note("reload"); };
process.on("SIGHUP", reload);
process.on("SIGUSR2", reload);
process.on("SIGTERM", () => { note("stop"); process.exit(0); });
setTimeout(() => http.createServer((request, response) => response.end(JSON.stringify({ pid: process.pid, config: current }))).listen(Number(port), "127.0.0.1"), Number(delay));
if (Number(exitAfter) > 0) setTimeout(() => process.exit(7), Number(exitAfter));
setInterval(() => {}, 1000);
`;

async function setup(t, secrets = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-controller-"));
  const record = join(directory, "record.log");
  await writeFile(record, "");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, "agent") });
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  const ports = { db: await freePort(), app: await freePort(), web: await freePort(), cache: await freePort() };
  const makeHost = (over = {}) => makeAgentPlanHost({
    runner, workloadId: "p1", cwd: directory, commands: { node: process.execPath }, ports, baseEnvironment: {},
    resolveSecret: (name) => secrets[name] === undefined ? Effect.fail({ _tag: "RecipeError", operation: "secret", message: "missing" }) : Effect.succeed(secrets[name]),
    pollInterval: 40, stopGrace: 2000, ...over,
  });
  const controllerFor = (host = makeHost()) => Effect.runPromise(makePlanController.pipe(Effect.provideService(PlanHost, host)));
  const events = [];
  const watch = (controller) => {
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(controller.events);
      for (;;) events.push(yield* PubSub.take(subscription));
    })));
    t.after(() => Effect.runPromise(Fiber.interrupt(fiber)));
    return sleep(30);
  };
  const config = (name) => join(directory, `${name}.conf`);
  const proc = (name, port, { delay = 0, exitAfter = 0, dependsOn = [], timeoutMs = 5000, args = [], env = {}, reload, withConfig = true } = {}) => ({
    name, command: "node", dependsOn, env, readiness: { port, timeoutMs },
    args: ["-e", SERVICE, name, String(ports[port]), record, config(name), String(delay), String(exitAfter), ...args],
    ...(withConfig ? { config: [config(name)] } : {}),
    ...(reload ? { update: { strategy: "reload", signal: reload } } : {}),
  });
  const lines = () => readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(" "));
  const pidOf = (name) => Number(lines().filter(([kind, who]) => kind === "start" && who === name).at(-1)?.[2]);
  const ask = async (port) => (await fetch(`http://127.0.0.1:${ports[port]}/`)).json();
  return { directory, runner, ports, makeHost, controllerFor, watch, events, proc, config, lines, pidOf, ask, record };
}
const run = (effect) => Effect.runPromise(effect);
const failureOf = async (effect) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Cause.squash(exit.cause);
};
const alive = (port) => Effect.runPromise(loopbackPortAccepts(port));

test("starting a plan: dependencies first, each only once its dependency is ready, independent ones together", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, lines } = await setup(t);
  const controller = await controllerFor();
  const report = await run(controller.reconcile({ processes: [
    proc("web", "web", { dependsOn: ["app"] }), proc("app", "app", { dependsOn: ["db"], delay: 200 }), proc("db", "db", { delay: 700 }), proc("cache", "cache", { delay: 700 }),
  ] }));
  assert.deepEqual([...report.added].sort(), ["app", "cache", "db", "web"]);
  const at = Object.fromEntries(lines().filter(([kind]) => kind === "start").map(([, name, , time]) => [name, Number(time)]));
  assert.ok(at.app - at.db >= 650 && at.web - at.app >= 150, "each waited for what it depends on to accept connections");
  assert.ok(Math.abs(at.cache - at.db) < 400, "independent processes did not wait for each other");
  assert.equal(await run(controller.running), true);
  await run(controller.stop);
  assert.deepEqual(lines().filter(([kind]) => kind === "stop").map(([, name]) => name).slice(0, 1), ["web"], "dependents stop first");
  assert.equal(await run(controller.running), false);
});

test("the same plan again changes nothing: not one process is touched", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, lines, ask } = await setup(t);
  const controller = await controllerFor();
  const plan = { processes: [proc("db", "db"), proc("web", "web", { dependsOn: ["db"] })] };
  await run(controller.reconcile(plan));
  const before = lines().length;
  const pid = (await ask("web")).pid;
  const report = await run(controller.reconcile(plan));
  assert.deepEqual(report, { kept: ["db", "web"], reloaded: [], replaced: [], added: [], removed: [] });
  assert.equal(lines().length, before, "no process started, stopped or signalled");
  assert.equal((await ask("web")).pid, pid);
  await run(controller.stop);
});

test("a configuration change reloads a process that can, in place, with no failed request", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, config, ask, watch, events, lines, ports } = await setup(t);
  const controller = await controllerFor();
  await watch(controller);
  writeFileSync(config("web"), "version one");
  const plan = { processes: [proc("web", "web", { reload: "SIGHUP" })] };
  await run(controller.reconcile(plan));
  const first = await ask("web");
  assert.equal(first.config, "version one");

  // Traffic runs the whole time.
  let stop = false; let failures = 0; let served = 0; const bodies = new Set();
  const traffic = (async () => { while (!stop) { try { bodies.add((await ask("web")).config); served += 1; } catch { failures += 1; } await sleep(5); } })();
  await sleep(100);
  writeFileSync(config("web"), "version two");
  const report = await run(controller.reconcile(plan));
  await sleep(100);
  stop = true; await traffic;

  assert.deepEqual(report.reloaded, ["web"]);
  assert.equal(failures, 0, "not one request failed during the reload");
  assert.ok(served > 20);
  assert.deepEqual([...bodies].sort(), ["version one", "version two"]);
  assert.equal((await ask("web")).pid, first.pid, "the same process, now serving the new configuration");
  assert.equal(lines().filter(([kind]) => kind === "start").length, 1);
  assert.ok(events.some((event) => event._tag === "Reloaded" && event.signal === "SIGHUP"));
  void ports;
  await run(controller.stop);
});

test("a configuration change restarts a process that cannot reload, and leaves its neighbours running", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, config, pidOf, ask } = await setup(t);
  const controller = await controllerFor();
  writeFileSync(config("db"), "one");
  const plan = { processes: [proc("db", "db"), proc("web", "web", { dependsOn: ["db"], reload: "SIGHUP" })] };
  await run(controller.reconcile(plan));
  const [dbPid, webPid] = [pidOf("db"), pidOf("web")];
  writeFileSync(config("db"), "two");
  const report = await run(controller.reconcile(plan));
  assert.deepEqual([report.replaced, report.kept], [["db"], ["web"]]);
  assert.notEqual(pidOf("db"), dbPid);
  assert.equal((await ask("db")).config, "two");
  assert.equal((await ask("web")).pid, webPid, "what depends on it was not restarted");
  await run(controller.stop);
});

test("only the process whose launch changed is replaced; one added and one dropped come and go in order", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, pidOf, lines, ask } = await setup(t);
  const controller = await controllerFor();
  await run(controller.reconcile({ processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"] }), proc("web", "web", { dependsOn: ["app"] })] }));
  const pids = { db: pidOf("db"), app: pidOf("app") };
  const report = await run(controller.reconcile({ processes: [
    proc("db", "db"), proc("app", "app", { dependsOn: ["db"], args: ["a-new-argument"] }), proc("cache", "cache", { dependsOn: ["db"] }),
  ] }));
  assert.deepEqual([report.kept, report.replaced, report.added, report.removed], [["db"], ["app"], ["cache"], ["web"]]);
  assert.equal((await ask("db")).pid, pids.db);
  assert.notEqual(pidOf("app"), pids.app);
  assert.deepEqual(await run(controller.names).then((names) => [...names].sort()), ["app", "cache", "db"]);
  assert.ok(lines().some(([kind, name]) => kind === "stop" && name === "web"));
  await run(controller.stop);
});

test("a process that died is brought back by the next reconcile, and only that one", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, pidOf, ask, watch, events } = await setup(t);
  const controller = await controllerFor();
  await watch(controller);
  const plan = { processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"], exitAfter: 1200 })] };
  await run(controller.reconcile(plan));
  const dbPid = pidOf("db");
  for (let attempt = 0; attempt < 100 && !events.some((event) => event._tag === "Exited"); attempt += 1) await sleep(50);
  assert.deepEqual(events.filter((event) => event._tag === "Exited").map((event) => [event.name, event.code]), [["app", 7]], "reported, not restarted by itself");
  assert.equal(await run(controller.running), false);
  const report = await run(controller.reconcile({ processes: [plan.processes[0], proc("app", "app", { dependsOn: ["db"] })] }));
  assert.deepEqual([report.kept, report.replaced], [["db"], ["app"]], "the changed launch (no exit) is a new process, the healthy one is left");
  assert.equal(pidOf("db"), dbPid);
  assert.equal((await ask("app")).pid > 0, true);
  await run(controller.stop);
});

test("a process that is not ready, or exits first, fails the reconcile and is cleaned up; the table tells the truth", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, ports } = await setup(t);
  const controller = await controllerFor();
  const slow = await failureOf(controller.reconcile({ processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"], delay: 30_000, timeoutMs: 700 }), proc("web", "web", { dependsOn: ["app"] })] }));
  assert.equal(slow._tag, "RecipeError");
  assert.match(slow.message, /"app" was not ready on its port within 700 ms/);
  assert.deepEqual(await run(controller.names), ["db"], "what was ready stays, what failed is gone, what depended on it never started");
  assert.equal(await alive(ports.web), false);
  assert.equal(await alive(ports.app), false);

  const exits = await failureOf(controller.reconcile({ processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"], delay: 5000, exitAfter: 200 })] }));
  assert.match(exits.message, /"app" exited before it was ready \(code 7\)/);
  await run(controller.stop);
  assert.equal(await alive(ports.db), false);
});

test("an upgrade that fails halfway is undone by reconciling to the previous plan", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, config, pidOf, ask } = await setup(t);
  const controller = await controllerFor();
  writeFileSync(config("web"), "good");
  const previous = { processes: [proc("db", "db"), proc("web", "web", { dependsOn: ["db"], reload: "SIGHUP" })] };
  await run(controller.reconcile(previous));
  const webPid = pidOf("web");
  // The new plan replaces the database with one that never becomes ready.
  const failing = { processes: [proc("db", "db", { args: ["changed"], delay: 30_000, timeoutMs: 600 }), proc("web", "web", { dependsOn: ["db"], reload: "SIGHUP" })] };
  await failureOf(controller.reconcile(failing));
  assert.deepEqual(await run(controller.names), ["web"], "the old database was stopped to be replaced, the new one failed: reality, not a guess");
  const back = await run(controller.reconcile(previous));
  assert.deepEqual([back.added, back.kept], [["db"], ["web"]]);
  assert.equal((await ask("db")).config, "none");
  assert.equal((await ask("web")).pid, webPid, "the web tier was never touched");
  await run(controller.stop);
});

test("interrupting a reconcile stops the process it was bringing up", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, ports } = await setup(t);
  const controller = await controllerFor();
  const fiber = Effect.runFork(controller.reconcile({ processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"], delay: 30_000, timeoutMs: 20_000 })] }));
  for (let attempt = 0; attempt < 100 && !(await alive(ports.db)); attempt += 1) await sleep(50);
  await sleep(400);
  await Effect.runPromise(Fiber.interrupt(fiber));
  await sleep(400);
  assert.equal(await alive(ports.app), false);
  assert.deepEqual(await run(controller.names), ["db"], "what was ready is still tracked; the one in flight was stopped");
  await run(controller.stop);
});

test("two reconciles never interleave: they run one after the other, in the order they were asked", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, ask, lines } = await setup(t);
  const controller = await controllerFor();
  const a = { processes: [proc("db", "db", { delay: 300 })] };
  const b = { processes: [proc("db", "db", { delay: 300 }), proc("web", "web", { dependsOn: ["db"] })] };
  const [first, second] = await Promise.all([run(controller.reconcile(a)), run(controller.reconcile(b))]);
  assert.deepEqual([first.added, second.added, second.kept], [["db"], ["web"], ["db"]]);
  assert.equal((await ask("web")).pid > 0, true);
  assert.equal(lines().filter(([kind, name]) => kind === "start" && name === "db").length, 1);
  await run(controller.stop);
});

test("secrets are resolved at the last moment, reach the process, and never an error or the fingerprint", { timeout: 60_000 }, async (t) => {
  const { controllerFor, directory, ports, makeHost } = await setup(t, { "db-password": "hunter2-very-secret" });
  const controller = await controllerFor(makeHost());
  const out = join(directory, "seen.txt");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.env.PASSWORD + "|" + process.argv[process.argv.length - 1]); require("node:net").createServer((s) => { s.on("error", () => {}); s.end(); }).listen(Number(process.argv[1]), "127.0.0.1"); setInterval(()=>{},1000)`;
  const plan = { processes: [{ name: "db", command: "node", dependsOn: [], readiness: { port: "db", timeoutMs: 5000 },
    args: ["-e", script, String(ports.db), { secret: "db-password" }], env: { PASSWORD: { secret: "db-password" } } }] };
  await run(controller.reconcile(plan));
  assert.equal(readFileSync(out, "utf8"), "hunter2-very-secret|hunter2-very-secret");
  assert.ok(!JSON.stringify(await run(controller.fingerprints)).includes("hunter2"), "only digests are kept");
  await run(controller.stop);
  const missing = await failureOf(controller.reconcile({ processes: [{ ...plan.processes[0], args: [{ secret: "never-made" }] }] }));
  assert.ok(!JSON.stringify(missing).includes("hunter2"));
});

test("a command or port the host did not provide is refused before anything starts", { timeout: 60_000 }, async (t) => {
  const { controllerFor, proc, lines } = await setup(t);
  const controller = await controllerFor();
  assert.match((await failureOf(controller.reconcile({ processes: [{ ...proc("db", "db"), command: "php" }] }))).message, /did not provide/);
  assert.match((await failureOf(controller.reconcile({ processes: [{ ...proc("db", "db"), readiness: { port: "admin", timeoutMs: 1000 } }] }))).message, /no allocation/);
  assert.deepEqual(lines(), []);
});

test("a process can be ready when its file appears; one that never writes it fails at its deadline", { timeout: 60_000 }, async (t) => {
  const { controllerFor, directory } = await setup(t);
  const controller = await controllerFor();
  const marker = join(directory, "ready.sock");
  const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 500); setInterval(()=>{},1000)`;
  const make = (path, timeoutMs) => ({ processes: [{ name: "fpm", command: "node", args: ["-e", script], env: {}, dependsOn: [], readiness: { path, timeoutMs } }] });
  const started = Date.now();
  await run(controller.reconcile(make(marker, 5000)));
  assert.ok(Date.now() - started >= 450, "it waited for the file");
  await run(controller.stop);
  assert.match((await failureOf(controller.reconcile(make(join(directory, "never.sock"), 700)))).message, /not ready on its readiness file within 700 ms/);
});

test("the host's base environment reaches a process under the plan's own variables, and nothing else of the Platform's does", { timeout: 60_000 }, async (t) => {
  process.env.ZELAVIS_HOST_ONLY = "leaked";
  t.after(() => { delete process.env.ZELAVIS_HOST_ONLY; });
  const { controllerFor, makeHost, ports, directory } = await setup(t);
  const out = join(directory, "env.json");
  const controller = await controllerFor(makeHost({ baseEnvironment: { BASE: "host", SHARED: "base" } }));
  const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); require("node:net").createServer((s) => { s.on("error", () => {}); s.end(); }).listen(Number(process.argv[1]), "127.0.0.1"); setInterval(()=>{},1000)`;
  await run(controller.reconcile({ processes: [{ name: "app", command: "node", args: ["-e", script, String(ports.app)], env: { OWN: "plan", SHARED: "plan" }, dependsOn: [], readiness: { port: "app", timeoutMs: 5000 } }] }));
  const seen = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual([seen.BASE, seen.OWN, seen.SHARED, seen.ZELAVIS_HOST_ONLY], ["host", "plan", "plan", undefined]);
  await run(controller.stop);
});

/** What an Agent that outlived the Platform hands back for a process it kept running. */
function survivor(host, { args, cwd, replay = [] }) {
  const handlers = [];
  let end;
  const exit = new Promise((resolve) => { end = resolve; });
  const child = { workloadId: "p1", running: true, exit, stop: async () => { child.running = false; end({ code: 0, signal: null, requested: true }); return { code: 0, signal: null, requested: true }; }, listen: (handler) => handlers.push(handler) };
  return { child, handlers, end, entry: { process: child, command: { workloadId: "p1", executable: process.execPath, args, cwd: cwd ?? host }, replay } };
}

test("processes an Agent kept running are adopted when they match the plan exactly, with their output, and carry their configuration forward", { timeout: 60_000 }, async (t) => {
  const { controllerFor, directory, watch, events, makeHost } = await setup(t, { "db-password": "s3cret-value" });
  const controller = await controllerFor(makeHost());
  await watch(controller);
  const plan = { processes: [
    { name: "db", command: "node", args: ["db.js", { secret: "db-password" }], env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 1000 }, config: [join(directory, "db.conf")] },
    { name: "app", command: "node", args: ["app.js"], env: {}, dependsOn: ["db"], readiness: { port: "app", timeoutMs: 1000 } },
  ] };
  const db = survivor(directory, { args: ["db.js", "s3cret-value"], replay: [{ stream: "stdout", line: "database ready" }] });
  const app = survivor(directory, { args: ["app.js"] });
  // What a saved plan state holds: the controller's own digest over its configuration files.
  const recorded = createHash("sha256").update(JSON.stringify([[join(directory, "db.conf"), "absent"]])).digest("hex");
  await run(controller.adopt(plan, [app.entry, db.entry], { db: recorded }));
  assert.equal(await run(controller.running), true);
  assert.deepEqual((await run(controller.logs)).map((entry) => [entry.process, entry.line]), [["db", "database ready"]]);
  db.handlers[0]({ stream: "stderr", line: "later" });
  assert.equal((await run(controller.logs)).at(-1).line, "later");
  const same = await run(controller.reconcile(plan));
  assert.deepEqual(same, { kept: ["db", "app"], reloaded: [], replaced: [], added: [], removed: [] }, "adopted processes are kept by an identical plan");
  app.end({ code: 9, signal: null, requested: false });
  for (let attempt = 0; attempt < 50 && !events.some((event) => event._tag === "Exited"); attempt += 1) await sleep(20);
  assert.deepEqual(events.filter((event) => event._tag === "Exited").map((event) => [event.name, event.code]), [["app", 9]]);
  await run(controller.stop).catch(() => undefined);
});

test("adopted processes whose configuration was never recorded are treated as changed, so a reload or replacement catches them up", { timeout: 60_000 }, async (t) => {
  const { controllerFor, directory } = await setup(t);
  const controller = await controllerFor();
  const plan = { processes: [{ name: "web", command: "node", args: ["w.js"], env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 1000 }, config: [join(directory, "web.conf")], update: { strategy: "reload", signal: "SIGHUP" } }] };
  const web = survivor(directory, { args: ["w.js"] });
  web.child.signal = async (signal) => { web.signalled = signal; return true; };
  await run(controller.adopt(plan, [web.entry], {}));
  // Its readiness (a port nothing listens on) cannot be probed here, so only the decision is checked.
  const report = await failureOf(controller.reconcile(plan));
  assert.equal(web.signalled, "SIGHUP", "unknown configuration means reload now");
  assert.match(report.message, /was not ready/);
});

test("a process that does not belong to the plan, or claims another workload, or is claimed twice, is refused, not adopted", { timeout: 60_000 }, async (t) => {
  const { controllerFor, directory } = await setup(t);
  const plan = { processes: [{ name: "app", command: "node", args: ["app.js"], env: {}, dependsOn: [], readiness: { port: "app", timeoutMs: 1000 } }] };
  for (const entry of [
    survivor(directory, { args: ["other.js"] }).entry,
    survivor(directory, { args: ["app.js"], cwd: "/somewhere/else" }).entry,
    (() => { const odd = survivor(directory, { args: ["app.js"] }); odd.child.workloadId = "someone-else"; return odd.entry; })(),
  ]) {
    const controller = await controllerFor();
    assert.match((await failureOf(controller.adopt(plan, [entry], {}))).message, /does not belong to this Project's plan/);
  }
  const controller = await controllerFor();
  assert.match((await failureOf(controller.adopt(plan, [survivor(directory, { args: ["app.js"] }).entry, survivor(directory, { args: ["app.js"] }).entry], {}))).message, /does not belong/);
  const full = await controllerFor();
  await full.adopt(plan, [survivor(directory, { args: ["app.js"] }).entry], {}).pipe(Effect.runPromise);
  assert.match((await failureOf(full.adopt(plan, [survivor(directory, { args: ["app.js"] }).entry], {}))).message, /only be adopted into a controller that runs none/);
  void existsSync;
});

test("output is kept, bounded, and attributed to its process", { timeout: 60_000 }, async (t) => {
  const { controllerFor, ports } = await setup(t);
  const controller = await controllerFor();
  const script = `console.log("hello from db"); for (let i = 0; i < 800; i++) console.log("line " + i); require("node:net").createServer((s) => { s.on("error", () => {}); s.end(); }).listen(Number(process.argv[1]), "127.0.0.1"); setInterval(()=>{},1000)`;
  await run(controller.reconcile({ processes: [{ name: "db", command: "node", args: ["-e", script, String(ports.db)], env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 5000 } }] }));
  await sleep(300);
  const lines = await run(controller.logs);
  assert.ok(lines.length <= 500 && lines.length > 100);
  assert.ok(lines.every((entry) => entry.process === "db"));
  assert.equal(lines.at(-1).line, "line 799");
  await run(controller.stop);
});
