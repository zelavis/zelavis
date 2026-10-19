import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { randomUUID } from 'node:crypto';
import { serveAgentEngineControl } from '../dist/adapters/_agent-engine-control.js';
import { requestNodeRuntimeControl } from '../dist/adapters/_node-runtime-control.js';
import { createAgentProcessServer } from "../dist/adapters/_agent-ipc.js";
import { publishAgentDescriptor } from "../dist/adapters/_agent-lifecycle.js";
import { annotateAgentUpdate, prepareInstalledProjectAgentUpdate } from '../dist/adapters/_agent-update.js';
import { serveNodeProjectControl, nodeProjectControlPaths } from '../dist/adapters/_node-project-control.js';
import { ZELAVIS_VERSION } from '../dist/version.js';

const run = Effect.runPromise;
for (const failure of [false, true]) test(`conversion ${failure ? 'failure closes' : 'recovery warms integrations before opening'} admission`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp('/tmp/zv-convert-'), scope = await run(Scope.make());
  t.after(async () => { await run(Deferred.succeed(ready, undefined)); await run(Scope.close(scope, Exit.void)); await rm(directory, { recursive: true, force: true }); });
  const ready = Deferred.makeUnsafe(), warmed = Deferred.makeUnsafe();
  const projects = { list: async () => [{ id: 'wordpress', desiredState: 'running', runtime: { status: 'running' } }],
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
  assert.equal((await command('status')).phase, 'restoring');
  assert.equal(waiting.pollUnsafe(), undefined, 'accepted request remains waiting for the integration');
  await run(Deferred.succeed(ready, undefined));
  const result = await run(Fiber.await(waiting));
  if (failure) {
    assert.equal(Exit.isFailure(result), true);
    assert.equal((await command('status')).phase, 'failed'); assert.equal(previewsHeld, true);
  } else {
    assert.equal(Exit.isSuccess(result), true); result.value();
    assert.equal((await command('status')).phase, 'ready'); assert.equal(previewsHeld, false);
  }
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
