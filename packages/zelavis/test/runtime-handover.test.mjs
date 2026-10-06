import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Deferred, Fiber } from "effect";
import { createRuntimeAdmission, RuntimeAdmissionFull, RuntimeDrainTimeout } from "../dist/core/runtime/admission.js";
import { createRuntimeHandover, RuntimeHandoverFailure } from "../dist/core/runtime/handover.js";
import { IntegrationFailure } from "../dist/core/runtime/effect-boundary.js";

const release = version => ({ version, digest: `sha256:${version}` });
const old = release("1.0.0"), next = release("2.0.0");
const latch = () => Deferred.makeUnsafe();
const notify = deferred => Deferred.doneUnsafe(deferred, Effect.void);
const wait = deferred => Effect.runPromise(Deferred.await(deferred));

function fixture(fault = {}) {
  const events = [], admission = createRuntimeAdmission({ queueLimit: 2 });
  let owner = old.version, epoch = 1;
  const step = (name, work) => Effect.gen(function* () {
    events.push(name);
    if (typeof fault[name] === "function" ? fault[name]() : fault[name]) return yield* new IntegrationFailure(new Error(name));
    if (work) return yield* work();
  });
  const controller = createRuntimeHandover({ admission, initial: { release: old, owner: old.version, generation: 1 }, drainTimeoutMs: 20,
    host: {
      prepare: target => step("prepare", () => Effect.succeed(target.version)),
      deactivate: previous => step("deactivate", () => Effect.sync(() => { assert.equal(owner, previous); owner = undefined; })),
      activate: (candidate, generation) => step("activate", () => Effect.sync(() => { assert.equal(owner, undefined); owner = candidate; epoch = generation; return candidate; })),
      restore: (previous, generation) => step("restore", () => Effect.sync(() => { owner = previous.version; epoch = generation; return owner; })),
      discard: candidate => step("discard", () => Effect.sync(() => { if (owner === candidate) owner = undefined; })),
      probe: () => step("probe"),
      commit: (target, _, generation) => step(`commit:${target.version}`, () => Effect.sync(() => { assert.equal(owner, target.version); assert.equal(epoch, generation); })),
      checkpoint: value => step(`checkpoint:${value.phase}`),
    },
  });
  return { admission, controller, events, owner: () => owner };
}

test("admission bounds queued requests and cancellation releases queue slots", async () => {
  const gate = createRuntimeAdmission({ queueLimit: 1 });
  await Effect.runPromise(gate.pause);
  const fiber = Effect.runFork(gate.enter);
  assert.equal(gate.snapshot().waiting, 1);
  await assert.rejects(Effect.runPromise(gate.enter), error => error instanceof RuntimeAdmissionFull);
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(gate.snapshot().waiting, 0);
  await Effect.runPromise(gate.resume);
  const done = await Effect.runPromise(gate.enter);
  assert.equal(gate.snapshot().active, 1);
  done(); done();
  assert.equal(gate.snapshot().active, 0);
});

test("handover prepares while old requests run, then drains before changing ownership", async () => {
  const f = fixture(), done = await Effect.runPromise(f.admission.enter);
  const fiber = Effect.runFork(f.controller.replace(next));
  assert.deepEqual(f.events, ["prepare", "checkpoint:prepared"]);
  assert.equal(f.owner(), old.version);
  const queued = Effect.runFork(f.admission.enter);
  done();
  const result = await Effect.runPromise(Fiber.join(fiber));
  const finish = await Effect.runPromise(Fiber.join(queued)); finish();
  assert.equal(result.release, next);
  assert.equal(f.owner(), next.version);
  assert.deepEqual(f.events, ["prepare", "checkpoint:prepared", "checkpoint:releasing", "deactivate", "checkpoint:activating", "activate", "probe", "checkpoint:committing", "commit:2.0.0", "checkpoint:ready"]);
  assert.equal(f.admission.snapshot().paused, false);
});

test("a stream that cannot drain aborts update without disconnecting it or stopping the owner", async () => {
  const f = fixture(), done = await Effect.runPromise(f.admission.enter);
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), error => error instanceof RuntimeDrainTimeout);
  assert.equal(f.owner(), old.version);
  assert.equal(f.admission.snapshot().paused, false);
  assert.equal(f.admission.snapshot().active, 1);
  assert.deepEqual(f.events, ["prepare", "checkpoint:prepared", "discard"]);
  done();
});

for (const phase of ["activate", "probe", "commit:2.0.0", "checkpoint:ready", "deactivate"]) test(`failure at ${phase} fences candidate and restores previous owner at a newer generation`, async () => {
  let calls = 0;
  const f = fixture({ [phase]: phase === "probe" ? () => ++calls === 1 : true });
  // Fail only the candidate's probe; the restored owner must prove readiness too.
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), error => error instanceof RuntimeHandoverFailure);
  assert.equal(f.owner(), old.version);
  assert.equal(f.controller.snapshot().generation, 3);
  assert.equal(f.controller.snapshot().requiresRecovery, false);
  assert.equal(f.admission.snapshot().paused, false);
});

test("unproven rollback keeps ingress paused and refuses further updates", async () => {
  const f = fixture({ activate: true, restore: true });
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), error => error instanceof RuntimeHandoverFailure && Boolean(error.rollbackCause));
  assert.equal(f.controller.snapshot().requiresRecovery, true);
  assert.equal(f.admission.snapshot().paused, true);
  await assert.rejects(Effect.runPromise(f.controller.replace(release("3.0.0"))), error => error instanceof RuntimeHandoverFailure && /fenced recovery/.test(String(error.cause)));
});

test("failed durable releasing checkpoint leaves old owner running", async () => {
  const f = fixture({ "checkpoint:releasing": true });
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), RuntimeHandoverFailure);
  assert.equal(f.owner(), old.version);
  assert.equal(f.controller.snapshot().generation, 1);
  assert.equal(f.events.includes("restore"), false);
});

test("failed standby cleanup blocks another update without interrupting the old writable owner", async () => {
  const f = fixture({ discard: true }), done = await Effect.runPromise(f.admission.enter);
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), RuntimeDrainTimeout);
  assert.equal(f.owner(), old.version);
  assert.equal(f.admission.snapshot().paused, false);
  assert.equal(f.controller.snapshot().requiresRecovery, true);
  assert.match(f.controller.snapshot().recoveryFailure.message, /discard/);
  await assert.rejects(Effect.runPromise(f.controller.replace(next)), RuntimeHandoverFailure);
  done();
});

test("interruption before ownership transfer resumes old admission and discards prepared candidate", async () => {
  const f = fixture(), done = await Effect.runPromise(f.admission.enter);
  const fiber = Effect.runFork(f.controller.replace(next));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(f.owner(), old.version);
  assert.equal(f.admission.snapshot().paused, false);
  assert.equal(f.events.at(-1), "discard");
  done();
});

test("interruption during ownership transfer completes safe activation before releasing queued traffic", async () => {
  const admission = createRuntimeAdmission({ queueLimit: 1 }), entered = latch(), finish = latch();
  let activated = false;
  const controller = createRuntimeHandover({ admission, initial: { release: old, owner: "old", generation: 1 }, drainTimeoutMs: 100,
    host: { prepare: () => Effect.succeed("new"), deactivate: () => Effect.void,
      activate: () => Effect.gen(function* () { notify(entered); yield* Deferred.await(finish); activated = true; return "new"; }),
      restore: () => Effect.succeed("old"), probe: () => Effect.void, discard: () => Effect.void,
      checkpoint: () => Effect.void, commit: () => Effect.void },
  });
  const fiber = Effect.runFork(controller.replace(next));
  await wait(entered);
  const interruption = Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(admission.snapshot().paused, true);
  notify(finish); await interruption;
  assert.equal(activated, true);
  assert.equal(controller.snapshot().release, next);
  assert.equal(admission.snapshot().paused, false);
});
