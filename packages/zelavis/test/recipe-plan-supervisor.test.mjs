// A process plan run through the real local Agent runner: order, readiness, failure cleanup,
// stop order, secrets, and interruption, with real child processes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Fiber } from "effect";

import { startProcessPlan } from "zelavis/recipe";
import { loopbackPortAccepts } from "../dist/adapters/_loopback-probe.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";

const freePort = () => new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** A service: records when it started and stopped, listens after `delayMs`, optionally exits. */
const SERVICE = `
const fs = require("node:fs"), net = require("node:net");
const [name, port, delay, exitAfter, record] = process.argv.slice(1);
fs.appendFileSync(record, "start " + name + " " + Date.now() + "\\n");
process.on("SIGTERM", () => { fs.appendFileSync(record, "stop " + name + " " + Date.now() + "\\n"); process.exit(0); });
setTimeout(() => net.createServer().listen(Number(port), "127.0.0.1"), Number(delay));
if (Number(exitAfter) > 0) setTimeout(() => process.exit(7), Number(exitAfter));
setInterval(() => {}, 1000);
`;

async function setup(t, secrets = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-plan-"));
  const record = join(directory, "record.log");
  await writeFile(record, "");
  const runner = createLocalAgentProcessRunner({ stateDirectory: join(directory, "agent") });
  t.after(async () => { await runner.close(); await rm(directory, { recursive: true, force: true }); });
  const ports = { db: await freePort(), app: await freePort(), web: await freePort() };
  const exited = [];
  const options = {
    runner, workloadId: "p1", cwd: directory, commands: { node: process.execPath }, ports,
    resolveSecret: (name) => secrets[name] === undefined ? Effect.fail({ _tag: "RecipeError", operation: "secret", message: "missing" }) : Effect.succeed(secrets[name]),
    probe: loopbackPortAccepts, pollMs: 50, stopGraceMs: 2000,
    onExit: (name, exit) => exited.push([name, exit.code]),
  };
  const proc = (name, port, { delay = 0, exitAfter = 0, dependsOn = [], timeoutMs = 5000, args = [], env = {} } = {}) => ({
    name, command: "node", dependsOn, env, readiness: { port, timeoutMs },
    args: ["-e", SERVICE, name, String(ports[port]), String(delay), String(exitAfter), record, ...args],
  });
  const events = () => readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(" "));
  return { options, proc, events, ports, exited, directory };
}
const failureOf = async (effect) => {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected the start to fail");
  return Cause.squash(exit.cause);
};
const alive = async (port) => Effect.runPromise(loopbackPortAccepts(port));

test("processes start in dependency order, each only after what it depends on accepts connections", { timeout: 60_000 }, async (t) => {
  const { options, proc, events } = await setup(t);
  const plan = { processes: [
    proc("web", "web", { dependsOn: ["app"] }),
    proc("app", "app", { dependsOn: ["db"], delay: 200 }),
    proc("db", "db", { delay: 700 }),
  ] };
  const running = await Effect.runPromise(startProcessPlan(plan, options));
  const starts = Object.fromEntries(events().filter(([kind]) => kind === "start").map(([, name, at]) => [name, Number(at)]));
  assert.ok(starts.app - starts.db >= 650, "the app waited for the database to listen");
  assert.ok(starts.web - starts.app >= 150, "the web server waited for the app to listen");
  assert.deepEqual([...running.names].sort(), ["app", "db", "web"]);
  assert.equal(running.running(), true);
  await Effect.runPromise(running.stop);
  const stops = events().filter(([kind]) => kind === "stop").map(([, name]) => name);
  assert.deepEqual(stops, ["web", "app", "db"], "dependents stop before what they depend on");
  await Effect.runPromise(running.stop);
});

test("independent processes start together", { timeout: 60_000 }, async (t) => {
  const { options, proc, events } = await setup(t);
  const running = await Effect.runPromise(startProcessPlan({ processes: [proc("a", "db", { delay: 600 }), proc("b", "app", { delay: 600 })] }, options));
  const [a, b] = ["a", "b"].map((name) => Number(events().find(([kind, who]) => kind === "start" && who === name)[2]));
  assert.ok(Math.abs(a - b) < 400, "neither waited for the other");
  await Effect.runPromise(running.stop);
});

test("a process that is not ready in time fails the start and everything started is stopped", { timeout: 60_000 }, async (t) => {
  const { options, proc, ports, events } = await setup(t);
  const error = await failureOf(startProcessPlan({ processes: [
    proc("db", "db"),
    proc("app", "app", { dependsOn: ["db"], delay: 30_000, timeoutMs: 800 }),
    proc("web", "web", { dependsOn: ["app"] }),
  ] }, options));
  assert.equal(error._tag, "RecipeError");
  assert.match(error.message, /"app" was not ready on port "app" within 800 ms/);
  assert.equal(await alive(ports.db), false, "the database that did start was stopped");
  assert.ok(!events().some(([kind, who]) => kind === "start" && who === "web"), "what depended on the failure never started");
});

test("a process that exits before it is ready fails the start with how it ended", { timeout: 60_000 }, async (t) => {
  const { options, proc } = await setup(t);
  const error = await failureOf(startProcessPlan({ processes: [proc("db", "db", { delay: 5000, exitAfter: 200 })] }, options));
  assert.match(error.message, /"db" exited before it was ready \(code 7\)/);
});

test("a process that exits after the plan is ready is reported, not restarted", { timeout: 60_000 }, async (t) => {
  const { options, proc, exited, events } = await setup(t);
  const running = await Effect.runPromise(startProcessPlan({ processes: [proc("db", "db"), proc("app", "app", { exitAfter: 1500 })] }, options));
  for (let attempt = 0; attempt < 100 && exited.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(exited, [["app", 7]]);
  assert.equal(running.running(), false);
  assert.equal(events().filter(([kind, who]) => kind === "start" && who === "app").length, 1, "no restart");
  await Effect.runPromise(running.stop);
  assert.equal(exited.length, 1, "an exit the supervisor asked for is not reported as a failure");
});

test("secrets are resolved at the last moment, reach the process, and never an error", { timeout: 60_000 }, async (t) => {
  const { options, proc } = await setup(t, { "db-password": "hunter2-very-secret" });
  const out = join(options.cwd, "seen.txt");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, process.env.PASSWORD + "|" + process.argv[process.argv.length - 1]); require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1"); setInterval(()=>{},1000)`;
  const plan = { processes: [{
    name: "db", command: "node", dependsOn: [], readiness: { port: "db", timeoutMs: 5000 },
    args: ["-e", script, String(options.ports.db), { secret: "db-password" }], env: { PASSWORD: { secret: "db-password" } },
  }] };
  const running = await Effect.runPromise(startProcessPlan(plan, options));
  assert.equal(readFileSync(out, "utf8"), "hunter2-very-secret|hunter2-very-secret");
  await Effect.runPromise(running.stop);

  const missing = await failureOf(startProcessPlan({ processes: [{ ...plan.processes[0], args: [{ secret: "never-made" }] }] }, options));
  assert.ok(!JSON.stringify(missing).includes("hunter2"));
  const failed = await failureOf(startProcessPlan({ processes: [{ ...plan.processes[0], args: ["-e", "process.exit(1)", { secret: "db-password" }], readiness: { port: "db", timeoutMs: 2000 } }] }, options));
  assert.ok(!failed.message.includes("hunter2"), "an error never carries a secret");
});

test("a command or port the host did not provide is refused before anything starts", { timeout: 60_000 }, async (t) => {
  const { options, proc, events } = await setup(t);
  assert.match((await failureOf(startProcessPlan({ processes: [{ ...proc("db", "db"), command: "php" }] }, options))).message, /did not provide/);
  assert.match((await failureOf(startProcessPlan({ processes: [{ ...proc("db", "db"), readiness: { port: "admin", timeoutMs: 1000 } }] }, options))).message, /no allocation/);
  assert.deepEqual(events(), []);
});

test("interrupting a start stops what was started", { timeout: 60_000 }, async (t) => {
  const { options, proc, ports } = await setup(t);
  const fiber = Effect.runFork(startProcessPlan({ processes: [proc("db", "db"), proc("app", "app", { dependsOn: ["db"], delay: 30_000, timeoutMs: 20_000 })] }, options));
  for (let attempt = 0; attempt < 100 && !(await alive(ports.db)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  await Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await alive(ports.db), false);
});

test("output is kept, bounded, and attributed to its process", { timeout: 60_000 }, async (t) => {
  const { options } = await setup(t);
  const script = `console.log("hello from db"); for (let i = 0; i < 800; i++) console.log("line " + i); require("node:net").createServer().listen(Number(process.argv[1]), "127.0.0.1"); setInterval(()=>{},1000)`;
  const running = await Effect.runPromise(startProcessPlan({ processes: [{
    name: "db", command: "node", args: ["-e", script, String(options.ports.db)], env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 5000 },
  }] }, options));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = running.logs();
  assert.ok(lines.length <= 500 && lines.length > 100);
  assert.ok(lines.every((entry) => entry.process === "db"));
  assert.equal(lines.at(-1).line, "line 799");
  await Effect.runPromise(running.stop);
});
