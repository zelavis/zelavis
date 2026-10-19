import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { presentOperations } from '../dist/core/runtime/effect-boundary.js';
import { randomUUID } from 'node:crypto';
import { serveAgentEngineControl } from '../dist/adapters/_agent-engine-control.js';
import { requestNodeRuntimeControl } from '../dist/adapters/_node-runtime-control.js';
import { createAgentProcessServer } from "../dist/adapters/_agent-ipc.js";
import { publishAgentDescriptor } from "../dist/adapters/_agent-lifecycle.js";
import { annotateAgentUpdate, prepareInstalledProjectAgentUpdate } from '../dist/adapters/_agent-update.js';
import { serveNodeProjectControl, nodeProjectControlPaths } from '../dist/adapters/_node-project-control.js';
import { ZELAVIS_VERSION } from '../dist/version.js';

const run = Effect.runPromise;
const usedIntegration = async (directory, id) => {
  const path = join(directory, 'projects', id, '.zelavis', 'integration');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'runtime-handover.json'), '{}');
};
for (const failure of [false, true]) test(`conversion restores public admission before integration ${failure ? 'failure' : 'readiness'}`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-'), scope = await run(Scope.make());
  t.after(async () => { await run(Deferred.succeed(ready, undefined)); await run(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); });
  const ready = Deferred.makeUnsafe(), warmed = Deferred.makeUnsafe();
  await usedIntegration(directory, 'wordpress');
  const projects = { list: async () => [{ id: 'wordpress', recipe: { managed: {} }, desiredState: 'running', runtime: { status: 'running' } },
    { id: 'already-failed', recipe: {}, desiredState: 'running', runtime: { status: 'failed' } }],
    reconcile: async () => {}, gatewayTarget: async id => {
      assert.equal(id, 'wordpress'); await run(Deferred.succeed(warmed, undefined)); await run(Deferred.await(ready));
      if (failure) throw Error('Integration recovery failed');
      return 'http://127.0.0.1:1234';
    } };
  let previewsHeld = false;
  const admission = await run(serveAgentEngineControl({ directory, generation: 3, projects, holdPreviews: value => { previewsHeld = value; } }).pipe(Scope.provide(scope)));
  const nonce = randomUUID(), command = action => run(requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action, nonce, release: ZELAVIS_VERSION, generation: 3 }));
  await assert.rejects(run(requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action: 'prepare', nonce, release: ZELAVIS_VERSION, generation: 2 })), /another engine/);
  assert.equal((await command('prepare')).phase, 'held'); assert.equal(previewsHeld, true);
  const waiting = Effect.runFork(admission.enter);
  assert.equal((await command('restore')).phase, 'restoring');
  await run(Deferred.await(warmed));
  const recovering = await command('status');
  assert.equal(recovering.phase, 'ready', 'Agent conversion completes independently of private App warmup');
  assert.deepEqual(recovering.privateRecovery, { pending: 1, failed: 0 });
  const result = await run(Fiber.await(waiting));
  assert.equal(Exit.isSuccess(result), true, 'a private integration must not hold recovered public traffic');
  result.value();
  assert.equal(previewsHeld, false);
  await run(Deferred.succeed(ready, undefined));
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await command('status');
    if (status.privateRecovery.pending === 0) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (failure) {
    assert.equal(status.phase, 'ready'); assert.deepEqual(status.privateRecovery, { pending: 0, failed: 1 });
    assert.equal(status.failure, undefined);
    assert.equal(previewsHeld, false);
  } else {
    assert.equal(status.phase, 'ready'); assert.equal(previewsHeld, false);
  }
});

for (const fault of ['coordination', 'reconcile', 'integration']) test(`conversion ${fault} deadline releases the hold and reports failure`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-deadline-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (fault === 'integration') await usedIntegration(directory, 'one');
  await run(Effect.gen(function* () {
    const projects = presentOperations({
      list: () => Effect.succeed([{ id: 'one', recipe: { managed: {} }, desiredState: 'running', runtime: { status: 'running' } }]),
      reconcile: () => fault === 'reconcile' ? Effect.never : Effect.void,
      gatewayTarget: () => Effect.never,
    });
    let previewsHeld = false;
    const admission = yield* serveAgentEngineControl({ directory, generation: 1, projects, holdPreviews: value => { previewsHeld = value; } });
    const nonce = randomUUID(), command = action => requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action, nonce, release: ZELAVIS_VERSION, generation: 1 });
    yield* command('prepare');
    const waiting = yield* Effect.forkChild(admission.enter);
    if (fault !== 'coordination') yield* command('restore');
    yield* TestClock.adjust(fault === 'coordination' ? '120 seconds' : '90 seconds');
    const released = yield* Fiber.join(waiting); released();
    const status = yield* command('status');
    if (fault === 'integration') {
      assert.equal(status.phase, 'ready'); assert.deepEqual(status.privateRecovery, { pending: 0, failed: 1 });
    } else {
      assert.equal(status.phase, 'failed');
      assert.match(status.failure, fault === 'coordination' ? /coordination expired/ : /recovery deadline|conversion deadline/);
    }
    assert.equal(previewsHeld, false);
    assert.equal(admission.snapshot().closed, false);
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped));
});

test('one stalled private backend does not prevent another backend from recovering', { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-independent-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const id of ['stalled', 'healthy']) await usedIntegration(directory, id);
  await run(Effect.gen(function* () {
    let recovered = false;
    const projects = presentOperations({
      list: () => Effect.succeed(['stalled', 'healthy'].map(id => ({ id, recipe: { managed: {} }, desiredState: 'running', runtime: { status: 'running' } }))),
      reconcile: () => Effect.void,
      gatewayTarget: id => id === 'stalled' ? Effect.never : Effect.sync(() => { recovered = true; return 'http://127.0.0.1:1234'; }),
    });
    const admission = yield* serveAgentEngineControl({ directory, generation: 1, projects });
    const nonce = randomUUID(), command = action => requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action, nonce, release: ZELAVIS_VERSION, generation: 1 });
    yield* command('prepare'); yield* command('restore');
    yield* TestClock.adjust('1 millis');
    assert.equal(recovered, true);
    assert.equal((yield* command('status')).phase, 'ready');
    assert.equal(admission.snapshot().paused, false);
    yield* TestClock.adjust('90 seconds');
    assert.deepEqual((yield* command('status')).privateRecovery, { pending: 0, failed: 1 });
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped));
});

test('conversion leaves a hosting-only Project backend lazy', { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-unused-'), scope = await run(Scope.make());
  t.after(async () => { await run(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); });
  let starts = 0;
  const projects = { list: async () => [{ id: 'unused', recipe: { managed: {} }, desiredState: 'running', runtime: { status: 'running' } }],
    reconcile: async () => {}, gatewayTarget: async () => { starts++; throw Error('An unused backend must stay lazy'); } };
  const admission = await run(serveAgentEngineControl({ directory, generation: 1, projects }).pipe(Scope.provide(scope)));
  const nonce = randomUUID(), command = action => run(requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action, nonce, release: ZELAVIS_VERSION, generation: 1 }));
  await command('prepare'); await command('restore');
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = await command('status'); if (status.phase !== 'restoring') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(status.phase, 'ready'); assert.equal(starts, 0);
  assert.equal(admission.snapshot().paused, false);
});

test('an earlier conversion watchdog cannot expire a later conversion', { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-watchdog-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run(Effect.gen(function* () {
    yield* serveAgentEngineControl({ directory, generation: 1 });
    const command = (action, nonce) => requestNodeRuntimeControl(join(directory, 'agent-update.sock'), { action, nonce, release: ZELAVIS_VERSION, generation: 1 });
    const first = randomUUID(), second = randomUUID();
    yield* command('prepare', first); yield* command('restore', first);
    yield* TestClock.adjust('119 seconds');
    assert.equal((yield* command('status', first)).phase, 'ready');
    yield* command('prepare', second);
    yield* TestClock.adjust('1 second');
    assert.equal((yield* command('status', second)).phase, 'held');
    yield* TestClock.adjust('119 seconds');
    assert.equal((yield* command('status', second)).phase, 'failed');
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped));
});

test('Agent diagnostics mark a committed engine as degraded and retain explicit conversion history', async t => {
  const directory = await mkdtemp('/tmp/zv-agent-report-'); t.after(() => rm(directory, { recursive: true, force: true }));
  const runRecord = { id: 'update-proof', to: ZELAVIS_VERSION, state: 'succeeded', message: 'Engine committed.' };
  await writeFile(join(directory, 'agent-updates.json'), JSON.stringify([{ id: runRecord.id, target: ZELAVIS_VERSION, converted: true, degraded: true, message: 'Projects restarted once; Agent recovery failed.' }]));
  const annotated = await run(annotateAgentUpdate(directory, runRecord));
  assert.equal(annotated.state, 'failed'); assert.equal(annotated.to, ZELAVIS_VERSION);
  assert.match(annotated.message, /Engine committed.*Projects restarted once/);
  assert.deepEqual(await run(annotateAgentUpdate(directory, { ...runRecord, id: 'another-update' })), { ...runRecord, id: 'another-update' });
});


test('private host commands authenticate, deduplicate within their deadline, and refuse replay-cache overflow', async t => {
  const directory = await mkdtemp('/tmp/zv-private-'), scope = await run(Scope.make());
  t.after(async () => { await run(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); });
  const project = join(directory, 'projects', 'sample');
  let invocations = 0; const output = [];
  await run(serveNodeProjectControl({ directory: project, emit: value => output.push(value), acknowledge: () => false,
    command: () => Effect.sync(() => ({ type: 'status', count: ++invocations })),
  }).pipe(Scope.provide(scope)));
  const paths = nodeProjectControlPaths(project), { token } = JSON.parse(await readFile(paths.credentialsFile, 'utf8'));
  const input = { id: 'command-0', action: 'status', expiresAt: Date.now() + 30000 };
  await assert.rejects(run(requestNodeRuntimeControl(paths.socketPath, input, 'wrong')), /authentication/);
  await run(requestNodeRuntimeControl(paths.socketPath, input, token));
  await run(requestNodeRuntimeControl(paths.socketPath, input, token));
  assert.equal(invocations, 1); assert.equal(output.length, 2);
  await assert.rejects(run(requestNodeRuntimeControl(paths.socketPath, { ...input, action: 'replace' }, token)), /reused/);
  for (let index = 1; index < 128; index++) await run(requestNodeRuntimeControl(paths.socketPath, { ...input, id: `command-${index}` }, token));
  await assert.rejects(run(requestNodeRuntimeControl(paths.socketPath, { ...input, id: 'overflow' }, token)), /queue is full/);
  await run(requestNodeRuntimeControl(paths.socketPath, input, token));
  assert.equal(invocations, 128, 'a retry cannot execute again because a newer command evicted its result');
  await assert.rejects(run(requestNodeRuntimeControl(paths.socketPath, { ...input, id: 'expired', expiresAt: Date.now() - 1 }, token)), /expired/);
});


test('Agent restart failure records degradation without rejecting the committed engine transaction', async t => {
  const directory = await mkdtemp('/tmp/zv-agent-failure-'), updates = join(directory, 'update');
  const runner = { name: 'failure-fixture', recover: async () => [], detach: async () => {},
    start: async () => { throw Error('No workload belongs to this fixture'); }, close: async () => {} };
  const server = await createAgentProcessServer({ directory: join(directory, 'agent'), runner });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  await run(publishAgentDescriptor(join(directory, 'agent'), true));
  await mkdir(updates); const target = `${ZELAVIS_VERSION}.agent-fault`;
  const status = { id: randomUUID(), to: target, state: 'running' };
  await writeFile(join(updates, 'status.json'), JSON.stringify(status));
  const selection = join(directory, 'selected-engine.json'); await writeFile(selection, JSON.stringify({ version: target }));
  const job = await run(prepareInstalledProjectAgentUpdate({ prefix: directory, instance: 'default', dataDirectory: directory, target, engineGeneration: 2 }));
  assert.equal(Effect.isEffect(job), true);
  const bin = join(directory, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 77\n', { mode: 0o700 });
  const previousPath = process.env.PATH;
  try { process.env.PATH = `${bin}:${previousPath}`; await run(job); }
  finally { process.env.PATH = previousPath; }
  const annotated = await run(annotateAgentUpdate(updates, { ...status, state: 'succeeded' }));
  assert.equal(annotated.state, 'failed'); assert.match(annotated.message, /remains selected.*Agent is degraded/);
  assert.equal(JSON.parse(await readFile(selection, 'utf8')).version, target);
});
