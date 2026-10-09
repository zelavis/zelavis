// The plan controller with no real processes and a controlled clock: exact timing of readiness and
// deadlines, and a seeded model that drives it through random plans and injected faults and checks
// it against what the fake machine says is actually running.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { PlanHost, RecipeError, makePlanController } from "zelavis/recipe";

/** A machine of pretend processes. Everything the controller does to the world lands here. */
function machine(options = {}) {
  const processes = [];
  const log = { starts: [], stops: [], signals: [] };
  const files = new Map();
  const readyPorts = new Set();
  const state = { failStart: new Set(), neverReady: new Set(), holdStops: false };
  const host = {
    workloadId: "p", cwd: "/p", commands: { tool: "/bin/tool" }, ports: { web: 1, db: 2 }, baseEnvironment: {},
    pollInterval: "10 millis", stopGrace: "1 second",
    resolveSecret: () => Effect.succeed("secret"),
    start: (command, startOptions) => Effect.suspend(() => {
      const name = command.args[0];
      if (state.failStart.has(name)) return Effect.fail(new RecipeError({ operation: "start", message: `injected start failure for ${name}` }));
      const child = { name, running: true, workloadId: "p", exit: new Promise(() => undefined), options: startOptions, command };
      processes.push(child);
      log.starts.push(name);
      if (!state.neverReady.has(name)) readyPorts.add(name === "db" ? 2 : 1);
      return Effect.succeed(child);
    }),
    stop: (child, grace) => Effect.sync(() => {
      log.stops.push([child.name, grace]);
      child.running = false;
      child.options.onExit({ code: 0, signal: null, requested: true });
    }),
    signal: (child, signal) => Effect.sync(() => { log.signals.push([child.name, signal]); }),
    probePort: (port) => Effect.sync(() => readyPorts.has(port)),
    pathExists: () => Effect.succeed(true),
    digestFile: (path) => Effect.sync(() => files.get(path) ?? "absent"),
    digest: (text) => Effect.sync(() => createHash("sha256").update(text).digest("hex")),
    ...options,
  };
  return { host, processes, log, files, readyPorts, state, running: () => processes.filter((child) => child.running).map((child) => child.name).sort() };
}

const build = (fake) => makePlanController.pipe(Effect.provideService(PlanHost, fake.host));
const proc = (name, over = {}) => ({
  name, command: "tool", args: [name, ...(over.args ?? [])], env: {}, dependsOn: over.dependsOn ?? [],
  readiness: { port: over.port ?? "web", timeoutMs: over.timeoutMs ?? 1000 },
  ...(over.config ? { config: over.config } : {}), ...(over.reload ? { update: { strategy: "reload", signal: over.reload } } : {}),
});
const withClock = (program) => program.pipe(Effect.provide(TestClock.layer()), Effect.scoped);

test("readiness is polled on the interval and succeeds on the first poll that sees it", async () => {
  const fake = machine();
  fake.state.neverReady.add("web");
  const outcome = await Effect.runPromise(withClock(Effect.gen(function* () {
    const controller = yield* build(fake);
    const fiber = yield* Effect.forkChild(controller.reconcile({ processes: [proc("web")] }));
    yield* TestClock.adjust("100 millis");
    assert.equal(fiber.pollUnsafe(), undefined, "still waiting: nothing is listening");
    fake.readyPorts.add(1);
    yield* TestClock.adjust("10 millis");
    return yield* Fiber.join(fiber);
  })));
  assert.deepEqual(outcome.added, ["web"]);
});

test("a process that is never ready fails at its deadline exactly, and is stopped", async () => {
  const fake = machine();
  fake.state.neverReady.add("web");
  const exit = await Effect.runPromise(withClock(Effect.gen(function* () {
    const controller = yield* build(fake);
    const fiber = yield* Effect.forkChild(controller.reconcile({ processes: [proc("web", { timeoutMs: 1000 })] }));
    yield* TestClock.adjust("999 millis");
    assert.equal(fiber.pollUnsafe(), undefined, "one millisecond early it is still trying");
    yield* TestClock.adjust("1 millis");
    return yield* Fiber.await(fiber);
  })));
  assert.ok(Exit.isFailure(exit));
  assert.match(Cause.squash(exit.cause).message, /"web" was not ready on its port within 1000 ms/);
  assert.deepEqual(fake.log.stops.map(([name]) => name), ["web"], "the process that never came up was stopped");
  assert.deepEqual(fake.running(), []);
});

test("a process that exits before it is ready fails the step at once, without waiting for the deadline", async () => {
  const fake = machine();
  fake.state.neverReady.add("web");
  const exit = await Effect.runPromise(withClock(Effect.gen(function* () {
    const controller = yield* build(fake);
    const fiber = yield* Effect.forkChild(controller.reconcile({ processes: [proc("web", { timeoutMs: 600_000 })] }));
    yield* TestClock.adjust("50 millis");
    const child = fake.processes[0];
    child.running = false;
    child.options.onExit({ code: 3, signal: null, requested: false });
    yield* TestClock.adjust("10 millis");
    return yield* Fiber.await(fiber);
  })));
  assert.ok(Exit.isFailure(exit));
  assert.match(Cause.squash(exit.cause).message, /"web" exited before it was ready \(code 3\)/);
});

test("the grace given to a stopping process is the host's", async () => {
  const fake = machine({ stopGrace: "7 seconds" });
  await Effect.runPromise(withClock(Effect.gen(function* () {
    const controller = yield* build(fake);
    yield* controller.reconcile({ processes: [proc("web")] });
    yield* controller.stop;
  })));
  assert.deepEqual(fake.log.stops, [["web", "7 seconds"]]);
});

test("reload signals the process and does not stop or start anything", async () => {
  const fake = machine();
  await Effect.runPromise(withClock(Effect.gen(function* () {
    const controller = yield* build(fake);
    const plan = { processes: [proc("web", { config: ["/p/web.conf"], reload: "SIGUSR2" })] };
    fake.files.set("/p/web.conf", "one");
    yield* controller.reconcile(plan);
    fake.files.set("/p/web.conf", "two");
    const report = yield* controller.reconcile(plan);
    assert.deepEqual(report.reloaded, ["web"]);
    // And the new configuration is now the baseline: asking again does nothing.
    assert.deepEqual((yield* controller.reconcile(plan)).kept, ["web"]);
  })));
  assert.deepEqual(fake.log.signals, [["web", "SIGUSR2"]]);
  assert.deepEqual(fake.log.starts, ["web"]);
  assert.deepEqual(fake.log.stops, []);
});

// ---- the seeded model ---------------------------------------------------------------------------

const generator = (seed) => { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }; };
const NAMES = ["a", "b", "c", "d", "e"];

function randomPlan(random, files) {
  const present = NAMES.filter(() => random() < 0.7);
  return { processes: present.map((name, index) => {
    const dependsOn = present.slice(0, index).filter(() => random() < 0.4);
    const config = `/p/${name}.conf`;
    if (!files.has(config) || random() < 0.2) files.set(config, `v${Math.floor(random() * 3)}`);
    return proc(name, { dependsOn, args: [`l${Math.floor(random() * 2)}`], config: [config], ...(random() < 0.5 ? { reload: "SIGHUP" } : {}), timeoutMs: 500 });
  }) };
}

test("under random plans and injected faults the controller always matches the machine, and recovers by reconciling to the previous plan (seeded)", async () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    const random = generator(seed);
    const fake = machine();
    await Effect.runPromise(withClock(Effect.gen(function* () {
      const controller = yield* build(fake);
      let previous = { processes: [] };
      for (let round = 0; round < 8; round += 1) {
        const plan = randomPlan(random, fake.files);
        const faulty = random() < 0.25 && plan.processes.length > 0;
        const victim = plan.processes[Math.floor(random() * plan.processes.length)]?.name;
        if (faulty) fake.state.failStart.add(victim);
        const before = { starts: fake.log.starts.length, stops: fake.log.stops.length, signals: fake.log.signals.length };
        const outcome = yield* Effect.exit(controller.reconcile(plan));
        fake.state.failStart.clear();
        const label = `seed ${seed} round ${round}`;

        // The controller's table is the machine's truth, success or failure.
        assert.deepEqual([...(yield* controller.names)].sort(), fake.running(), `${label}: names match what runs`);
        assert.equal(fake.processes.filter((child) => child.running).length, new Set(fake.running()).size, `${label}: no process runs twice`);

        if (Exit.isSuccess(outcome)) {
          const report = outcome.value;
          assert.deepEqual(fake.running(), plan.processes.map((p) => p.name).sort(), `${label}: exactly the plan runs`);
          assert.equal(fake.log.starts.length - before.starts, report.added.length + report.replaced.length, `${label}: starts are additions and replacements`);
          assert.equal(fake.log.stops.length - before.stops, report.replaced.length + report.removed.length, `${label}: stops are replacements and removals`);
          assert.equal(fake.log.signals.length - before.signals, report.reloaded.length, `${label}: signals are reloads`);
          previous = plan;
          // Idempotent: the same plan again does nothing.
          const again = yield* controller.reconcile(plan);
          assert.deepEqual([again.reloaded, again.replaced, again.added, again.removed], [[], [], [], []], `${label}: converged`);
        } else {
          assert.ok(faulty, `${label}: only an injected fault may fail`);
          // Back to the previous plan restores it exactly, whatever the failure left behind.
          yield* controller.reconcile(previous);
          assert.deepEqual(fake.running(), previous.processes.map((p) => p.name).sort(), `${label}: recovered to the previous plan`);
        }
      }
      yield* controller.stop;
      assert.deepEqual(fake.running(), [], `seed ${seed}: stopped`);
    })));
  }
});
