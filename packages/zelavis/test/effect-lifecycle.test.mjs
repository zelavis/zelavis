import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { effectOperations, integration, IntegrationFailure, lifecycleGate, present, presentOperations, singleFlight } from "../dist/core/runtime/effect-boundary.js";
import { createProjectManager } from "../dist/project.js";
import { createMemorySystemStore } from "../dist/system-store.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";
import { createServerFrontendProjectRuntime } from "../dist/adapters/_server-frontend-project-runtime.js";

const signal = () => Deferred.makeUnsafe();
const notify = latch => Effect.runSync(Deferred.succeed(latch, undefined));
const wait = latch => Effect.runPromise(Deferred.await(latch));

test("integration leaves are lazy and preserve thrown error identity", async () => {
  const error = new Error("host failure");
  let calls = 0;
  const program = integration(() => { calls++; throw error; });
  assert.equal(calls, 0);
  await assert.rejects(Effect.runPromise(program), failure => failure instanceof IntegrationFailure && failure.cause === error);
  assert.equal(calls, 1);
  await assert.rejects(present(program), failure => failure === error);
});

test("native programs remain interruptible behind their public Promise presentations", async () => {
  const entered = signal();
  let released = false;
  const api = presentOperations({ work: () => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    yield* Effect.never;
  }).pipe(Effect.ensuring(Effect.sync(() => { released = true; }))) });
  const fiber = Effect.runFork(effectOperations(api).work());
  await wait(entered);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(released, true);
});

test("a non-cancellable host call finishes before interruption runs rollback", async () => {
  const entered = signal();
  let finish, completed = false, rolledBack = false;
  const operation = integration(() => {
    notify(entered);
    return new Promise(resolve => { finish = () => { completed = true; resolve(); }; });
  }).pipe(Effect.ensuring(Effect.sync(() => { assert.equal(completed, true); rolledBack = true; })));
  const fiber = Effect.runFork(operation);
  await wait(entered);
  const interruption = Effect.runPromise(Fiber.interrupt(fiber));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rolledBack, false);
  finish();
  await interruption;
  assert.equal(rolledBack, true);
});

test("lifecycle permits release after failure and interruption, and queued transitions do not overlap", async () => {
  const gate = lifecycleGate(), entered = signal();
  const fiber = Effect.runFork(gate("one", () => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    yield* Effect.never;
  })));
  await wait(entered);
  let second = false;
  const queued = Effect.runFork(gate("one", () => Effect.sync(() => { second = true; })));
  assert.equal(second, false);
  await Effect.runPromise(Fiber.interrupt(fiber));
  await Effect.runPromise(Fiber.join(queued));
  assert.equal(second, true);
  await assert.rejects(Effect.runPromise(gate("one", () => Effect.fail(new Error("failed")))), /failed/);
  assert.equal(await Effect.runPromise(gate("one", () => Effect.succeed("retry"))), "retry");
});

test("concurrent operations share a failure and can retry without retaining failed completion", async () => {
  const pending = new Map(), entered = signal(), release = signal(), error = new Error("cleanup failed");
  let calls = 0;
  const program = () => singleFlight(pending, "one", () => Effect.gen(function* () {
    calls++; yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); return yield* Effect.fail(error);
  }), true);
  const leader = Effect.runFork(Effect.result(program()));
  await wait(entered);
  const follower = Effect.runFork(Effect.result(program()));
  notify(release);
  const results = await Effect.runPromise(Effect.all([Fiber.join(leader), Fiber.join(follower)]));
  assert.equal(calls, 1);
  for (const result of results) assert.equal(result.failure, error);
  assert.equal(pending.size, 0);
  assert.equal(await Effect.runPromise(singleFlight(pending, "one", () => Effect.succeed("retry"), true)), "retry");
});

test("interrupting a single-flight leader completes its waiters and clears the operation", { timeout: 5000 }, async () => {
  const pending = new Map(), entered = signal();
  const leader = Effect.runFork(singleFlight(pending, "one", () => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined); yield* Effect.never;
  })));
  await wait(entered);
  const follower = Effect.runFork(singleFlight(pending, "one", () => Effect.succeed("must not execute")));
  await Effect.runPromise(Fiber.interrupt(leader));
  assert.equal(Exit.isFailure(await Effect.runPromiseExit(Fiber.join(follower))), true);
  assert.equal(pending.size, 0);
});

test("interrupted deletion persists its tombstone and resumes only unfinished participants", async () => {
  const entered = signal();
  let block = true, cleanups = 0, destroys = 0;
  const cleanup = presentOperations({ cleanup: () => Effect.gen(function* () {
    cleanups++;
    if (block) { yield* Deferred.succeed(entered, undefined); yield* Effect.never; }
  }) });
  const runtime = {
    name: "test", runtimeKinds: ["native"], capabilities: () => ({}),
    prepare: async () => {}, start: async () => ({ status: "running" }), stop: async () => ({ status: "stopped" }),
    status: async () => ({ status: "stopped" }), logs: async () => [], destroy: async () => { destroys++; }, close: async () => {},
  };
  const manager = await createProjectManager({ autoReconcile: false, runtime, store: createMemorySystemStore(),
    projectRecipes: [{ service: { name: "@zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} }, specifier: "@zelavis/app", status: "available" }],
    cleanupParticipants: [Object.assign(cleanup, { id: "test-cleanup" })],
  });
  try {
    await manager.create({ id: "one", name: "One", start: false });
    const fiber = Effect.runFork(effectOperations(manager).remove("one"));
    await wait(entered);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const pending = await manager.get("one");
    assert.equal(pending.deletion.status, "failed");
    assert.match(pending.deletion.error, /interrupted/);
    assert.equal(pending.deletion.currentParticipant, "test-cleanup");
    assert.ok(pending.deletion.completedParticipants.length > 0);
    assert.equal(destroys, 0);
    await assert.rejects(manager.start("one"), /pending deletion/);
    block = false;
    assert.equal(await manager.remove("one"), true);
    assert.equal(cleanups, 2);
    assert.equal(destroys, 1);
    assert.equal(await manager.get("one"), undefined);
  } finally { await manager.close(); }
});

for (const kind of ["node", "frontend"]) test(`${kind} startup interruption stops the acquired Agent process`, { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-effect-start-")), entered = signal();
  let stops = 0;
  const child = { workloadId: "one", running: true, stop: async () => { stops++; child.running = false; } };
  const agent = { start: async () => { notify(entered); return child; } };
  const project = { id: "one", name: "One", runtimeKind: "native", recipe: { name: "@acme/frontend", version: "1.0.0" } };
  let driver;
  try {
    if (kind === "node") {
      await mkdir(join(root, "one")); await writeFile(join(root, "one", "project.json"), "{}");
      driver = createNodeProcessProjectRuntime({ directory: root, agent });
    } else {
      const frontend = join(root, "frontend"); await mkdir(frontend);
      await writeFile(join(frontend, "package.json"), JSON.stringify({ name: "@acme/frontend", version: "1.0.0", zelavis: { kind: "frontend", frontend: { runtime: "server", start: ["node", "server.mjs"] } } }));
      driver = createServerFrontendProjectRuntime({ directory: root, agent, resolveFrontendDirectory: async () => frontend });
      await driver.prepare(project, { ...project.recipe, runtimeKinds: ["native"], specifier: "@acme/frontend" });
    }
    const fiber = Effect.runFork(effectOperations(driver).start(project));
    await wait(entered);
    await Effect.runPromise(Fiber.interrupt(fiber));
    assert.equal(child.running, false);
    assert.equal(stops, 1);
    assert.equal((await driver.status("one")).status, "failed");
  } finally { await driver?.close(); await rm(root, { recursive: true, force: true }); }
});

test("manager close interrupts its in-flight reconciliation and still closes the runtime", { timeout: 5000 }, async () => {
  const entered = signal(), store = createMemorySystemStore();
  let released = false, closed = false;
  const runtime = Object.assign(presentOperations({
    prepare: () => Effect.void,
    start: () => Effect.gen(function* () { yield* Deferred.succeed(entered, undefined); yield* Effect.never; })
      .pipe(Effect.ensuring(Effect.sync(() => { released = true; }))),
    stop: () => Effect.succeed({ status: "stopped" }), status: () => Effect.succeed({ status: "stopped" }),
    logs: () => Effect.succeed([]), destroy: () => Effect.void, close: () => Effect.sync(() => { closed = true; }),
  }), { name: "test", runtimeKinds: ["native"], capabilities: () => ({}) });
  const manager = await createProjectManager({ autoReconcile: false, runtime, store,
    projectRecipes: [{ service: { name: "@zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} }, specifier: "@zelavis/app", status: "available" }],
  });
  await manager.create({ id: "one", name: "One", start: false });
  const [record] = store.list("projects");
  store.set("projects", "one", { ...record.value, desiredState: "running" });
  const pending = manager.reconcile();
  await wait(entered);
  await manager.close();
  await pending;
  assert.equal(released, true);
  assert.equal(closed, true);
  await manager.reconcile();
});

test("reconciliation cannot provision or start a Project concurrently with its creation", { timeout: 5000 }, async () => {
  const entered = signal(), release = signal();
  let preparations = 0, active = 0, overlapping = false, starts = 0, running = false;
  const runtime = Object.assign(presentOperations({
    prepare: () => Effect.gen(function* () {
      overlapping ||= ++active > 1;
      if (++preparations === 1) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); }
    }).pipe(Effect.ensuring(Effect.sync(() => { active--; }))),
    start: () => Effect.sync(() => { starts++; running = true; return { status: "running" }; }),
    stop: () => Effect.succeed({ status: "stopped" }), status: () => Effect.sync(() => ({ status: running ? "running" : "stopped" })),
    logs: () => Effect.succeed([]), destroy: () => Effect.void, close: () => Effect.void,
  }), { name: "test", runtimeKinds: ["native"], capabilities: () => ({}) });
  const manager = await createProjectManager({ autoReconcile: false, runtime, store: createMemorySystemStore(),
    projectRecipes: [{ service: { name: "@zelavis/app", kind: "app", version: "1.0.0-test", api: {}, service: {} }, specifier: "@zelavis/app", status: "available" }],
  });
  try {
    const creation = manager.create({ id: "one", name: "One" });
    await wait(entered);
    const reconciliation = manager.reconcile();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preparations, 1);
    notify(release);
    await creation;
    await reconciliation;
    assert.equal(overlapping, false);
    assert.equal(starts, 1);
  } finally { notify(release); await manager.close(); }
});
