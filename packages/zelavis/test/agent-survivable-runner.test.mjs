import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalAgentProcessRunner } from '../dist/adapters/_agent-process-runner.js';
import { createAgentProcessClient } from '../dist/adapters/_agent-ipc.js';
import { Effect, Fiber, PubSub } from 'effect';
import { createServer } from 'node:net';
import { PlanHost, makePlanController } from 'zelavis/recipe';
import { makeAgentPlanHost } from '../dist/adapters/_plan-host.js';
import { createNodeRuntimeClient } from '../dist/adapters/_node-runtime-client.js';
import { createNodeProcessProjectRuntime } from '../dist/adapters/_node-project-runtime.js';
import { prepareAgentHandover } from '../dist/adapters/_agent-lifecycle.js';
import { createLocalSqliteSystemStore } from '../dist/adapters/_sqlite-system-store.js';
import { createProjectPlacementAuthority } from '../dist/platform/project-placement-authority.js';

const linux = process.platform === 'linux';
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25); }
  assert.fail('Timed out waiting for supervised process');
}
const cleanups = new WeakMap();
function cleanAfter(t, close) { cleanups.get(t).push(close); }
async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zv-survive-'));
  const stack = []; cleanups.set(t, stack);
  t.after(async () => {
    try { for (const close of stack.reverse()) await close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return directory;
}
function command(directory, source) {
  return { workloadId: 'sample', executable: process.execPath, args: ['-e', source], cwd: directory, env: {} };
}
async function record(directory) {
  const names = await readdir(directory);
  const name = names.find(name => name.endsWith('.json'));
  assert.ok(name, 'process must have a published record');
  return { name, value: JSON.parse(await readFile(join(directory, name), 'utf8')) };
}
async function agent(t, directory, daemon = false) {
  let stderr = '';
  const child = spawn(process.execPath, [new URL('./fixtures/survivable-agent.mjs', import.meta.url).pathname, directory, ...(daemon ? ['daemon'] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-8192); });
  cleanAfter(t, async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGINT');
    await exited;
  });
  try { await once(child, 'message', { signal: AbortSignal.timeout(10_000) }); }
  catch (cause) { throw Error(`Agent failed to listen: ${stderr}`, { cause }); }
  return { child, async kill(signal) { const exited = once(child, 'exit'); child.kill(signal); const code = (await exited)[0]; if (code && signal !== 'SIGKILL') throw Error(`Agent shutdown failed: ${stderr}`); return code; } };
}

test('survivable runner publishes no environment, streams output and preserves a process through detach', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const first = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  const lines = [];
  cleanAfter(t, () => first.close());
  const child = await first.start({ ...command(directory, `process.on('SIGUSR1',()=>console.error('signalled')); console.log('ready'); setInterval(()=>console.log('tick'),25);`), env: { SECRET: 'must-not-persist' } }, { onOutput: output => lines.push(output.line) });
  await waitFor(() => lines.includes('ready'));
  const original = await record(stateDirectory);
  assert.equal(JSON.stringify(original.value).includes('must-not-persist'), false);
  assert.equal(original.value.processId, child.id);
  await first.detach();
  const second = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  cleanAfter(t, () => second.close());
  const [attached] = await second.recover();
  assert.equal(attached.process.id, child.id);
  assert.ok(attached.replay.some(output => output.line === 'ready'));
  assert.equal((await record(stateDirectory)).value.pid, original.value.pid);
  const after = []; attached.process.listen(output => after.push(output.line));
  assert.equal(await attached.process.signal('SIGUSR1'), true);
  await waitFor(() => after.includes('signalled'));
  assert.equal((await attached.process.stop()).requested, true);
  assert.equal(attached.process.running, false);
  assert.equal((await readdir(stateDirectory)).some(name => name.endsWith('.json')), false);
});

test('exec gate searches the supplied PATH for bare programs and never falls back to the Agent PATH', { skip: !linux, timeout: 10000 }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const runner = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  cleanAfter(t, () => runner.close());
  const lines = [];
  const child = await runner.start({ ...command(directory, "console.log('path-ready');setInterval(()=>{},1000)"),
    executable: basename(process.execPath), env: { PATH: `${join(directory, 'absent')}:${dirname(process.execPath)}` } },
    { onOutput: output => lines.push(output.line) });
  await waitFor(() => lines.includes('path-ready'));
  assert.equal(child.running, true);
  assert.equal((await child.stop()).requested, true);
  const missing = await runner.start({ ...command(directory, "throw Error('must never run')"),
    executable: basename(process.execPath), env: { PATH: join(directory, 'absent') } });
  assert.equal((await missing.exit).code, 127);
});

test('kernel lock refuses concurrent recovery and corrupted records refuse admission', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const first = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  cleanAfter(t, () => first.close());
  const child = await first.start(command(directory, 'setInterval(()=>{},1000)'));
  const second = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  cleanAfter(t, () => second.close());
  await assert.rejects(second.recover(), /locked/);
  await child.stop();
  await first.close();
  await writeFile(join(stateDirectory, 'invalid.json'), '{broken', { mode: 0o600 });
  await assert.rejects(second.recover(), /JSON|Malformed/);
});

test('recovery refuses a reused PID even within the former age tolerance', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const first = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  const child = await first.start(command(directory, 'setInterval(()=>{},1000)'));
  const original = await record(stateDirectory);
  await first.detach();
  cleanAfter(t, () => { try { process.kill(-original.value.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await writeFile(join(stateDirectory, original.name), JSON.stringify({ ...original.value, startTicks: String(BigInt(original.value.startTicks) + 1n) }));
  const second = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  cleanAfter(t, () => second.close());
  assert.deepEqual(await second.recover(), []);
  assert.doesNotThrow(() => process.kill(original.value.pid, 0));
  assert.equal(child.running, true, 'detached old handle receives no fabricated exit');
});

for (const signal of ['SIGTERM', 'SIGKILL']) test(`real App survives Agent ${signal} and accepts re-keying without changing PID`, { skip: !linux, timeout: 30000 }, async t => {
  const directory = await root(t), projects = join(directory, 'projects');
  const recipe = { name: '@zelavis/app', title: 'App', version: JSON.parse(await readFile(new URL('../services/zelavis-app/package.json', import.meta.url), 'utf8')).version, specifier: '@zelavis/app', runtimeKinds: ['native'] };
  const project = { id: 'sample', name: 'Sample', kind: 'zelavis', runtimeKind: 'native', recipe };
  const first = await agent(t, directory, true);
  const store = createLocalSqliteSystemStore({ filename: join(directory, 'system', 'zelavis.sqlite') });
  cleanAfter(t, () => store.close());
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const granted = await authority.acquire({ projectId: project.id, nodeId: 'local', ownerSession: 'test-custody', expectedEpoch: 0, leaseMs: 60000 });
  assert.equal(granted.granted, true);
  const placement = { projectId: project.id, nodeId: 'local', ownerSession: 'test-custody', epoch: granted.placement.epoch };
  const client = await createAgentProcessClient({ directory: join(directory, 'agent') }); cleanAfter(t, () => client.close());
  let control, processHandle, exits = 0;
  const supervised = { ...client, start: async (command, options) => {
    processHandle = await client.start(command, { ...options,
      onOutput: output => { control?.accept(output.line); options?.onOutput?.(output); },
      onExit: exit => { exits++; options?.onExit?.(exit); } });
    control = createNodeRuntimeClient(processHandle, 5000);
    return processHandle;
  } };
  const driver = createNodeProcessProjectRuntime({ directory: projects, agent: supervised });
  await driver.prepare(project, recipe);
  const frontend = join(projects, project.id, '.zelavis', 'services', 'proof');
  await mkdir(join(frontend, 'dist'), { recursive: true });
  await writeFile(join(frontend, 'package.json'), JSON.stringify({ name: '@test/proof', version: '1.0.0',
    zelavis: { kind: 'frontend', frontend: { runtime: 'static', bundle: 'dist' } } }));
  await writeFile(join(frontend, 'dist', 'index.html'), '<h1>Still serving</h1>');
  const started = await driver.start(project, placement);
  const before = await record(join(projects, '.agent-processes'));
  if (signal === 'SIGTERM') await Effect.runPromise(prepareAgentHandover(join(directory, 'agent'), '2.0.0-alpha.999'));
  await first.kill(signal);
  const response = await fetch(`${started.url}/`); assert.equal(response.status, 200); await response.text();
  const second = await agent(t, directory, true);
  await waitFor(async () => {
    try { return (await Effect.runPromise(control.request({ action: 'status' }))).requiresRecovery === false; }
    catch { return false; }
  });
  assert.equal(exits, 0, 'transport loss must not publish a process exit');
  assert.equal(processHandle.running, true);
  const status = await driver.status(project.id);
  assert.equal(status.status, 'running'); assert.equal(status.url, started.url);
  assert.equal((await record(join(projects, '.agent-processes'))).value.pid, before.value.pid);
  // A recovered process belongs to no ChildProcess in this Agent. A second
  // handover must release read-only exit watchers without waiting for its death.
  await Effect.runPromise(prepareAgentHandover(join(directory, 'agent'), '2.0.0-alpha.999'));
  assert.equal(await second.kill('SIGTERM'), 0);
  await agent(t, directory, true);
  await Effect.runPromise(control.request({ action: 'status' }));
  assert.equal(exits, 0);
  assert.equal((await record(join(projects, '.agent-processes'))).value.pid, before.value.pid);
  await driver.stop(project.id);
  await driver.close();
});

test('stop issued while the Agent is absent waits for rebind and reports the real requested exit', { skip: !linux, timeout: 15000 }, async t => {
  const directory = await root(t), first = await agent(t, directory);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent'), reconnectTimeoutMs: 5000 });
  cleanAfter(t, () => client.close());
  let exits = 0;
  const child = await client.start(command(directory, 'setInterval(()=>{},1000)'), { onExit: () => exits++ });
  await first.kill('SIGKILL');
  const stopping = child.stop({ graceMs: 200 });
  assert.equal(child.running, true); assert.equal(exits, 0);
  await agent(t, directory);
  assert.equal((await stopping).requested, true);
  assert.equal(exits, 1); assert.equal(child.running, false);
});

for (const marker of ['absent', 'expired', 'wrong-generation']) test(`ordinary daemon stop rejects ${marker} handover authority`, { skip: !linux, timeout: 15000 }, async t => {
  const directory = await root(t), first = await agent(t, directory, true);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent') }); cleanAfter(t, () => client.close());
  const child = await client.start({ ...command(directory, 'setInterval(()=>{},1000)'), workloadId: 'environment:stop-proof' });
  const original = await record(join(directory, 'projects', '.agent-processes'));
  if (marker !== 'absent') {
    await Effect.runPromise(prepareAgentHandover(join(directory, 'agent'), '2.0.0-alpha.999'));
    const file = join(directory, 'agent', 'handover.json'), value = JSON.parse(await readFile(file, 'utf8'));
    if (marker === 'expired') value.expiresAt = new Date(Date.now() - 1000).toISOString();
    else value.generation = 'another-generation';
    await writeFile(file, JSON.stringify(value));
  }
  await first.kill('SIGTERM');
  await waitFor(async () => { try { const value = await readFile(`/proc/${original.value.pid}/stat`, 'utf8'); return ['Z', 'X'].includes(value.slice(value.lastIndexOf(')') + 2).split(' ')[0]); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error; } });
  assert.equal((await readdir(join(directory, 'projects', '.agent-processes'))).some(name => name.endsWith('.json')), false);
  assert.equal((await child.exit).requested, true);
});

test('interactive stdin is fenced on handover and a natural survivor exit is observed', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const first = createLocalAgentProcessRunner({ survivable: true, stateDirectory }); cleanAfter(t, () => first.close());
  const interactive = await first.start({ ...command(directory, "process.stdin.resume(); setInterval(()=>{},1000)"), stdin: 'pipe' });
  const survivor = await first.start(command(directory, 'setTimeout(()=>process.exit(17),1500)'));
  await first.detach();
  assert.equal((await interactive.exit).requested, true);
  const second = createLocalAgentProcessRunner({ survivable: true, stateDirectory }); cleanAfter(t, () => second.close());
  const [attached] = await second.recover(); assert.equal(attached.process.id, survivor.id);
  assert.deepEqual(await attached.process.exit, { code: null, signal: null, requested: false });
});

test('missing or replaced log inode refuses recovery without signalling its live process', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const first = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  const child = await first.start(command(directory, 'setInterval(()=>{},1000)'));
  const original = await record(stateDirectory); await first.detach();
  cleanAfter(t, () => { try { process.kill(-original.value.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await rm(join(stateDirectory, `${child.id}.out`));
  await writeFile(join(stateDirectory, `${child.id}.out`), 'foreign replacement', { mode: 0o600 });
  const second = createLocalAgentProcessRunner({ survivable: true, stateDirectory }); cleanAfter(t, () => second.detach());
  await assert.rejects(second.recover(), /recorded private/);
  assert.doesNotThrow(() => process.kill(original.value.pid, 0));
  assert.equal(await readFile(join(stateDirectory, `${child.id}.out`), 'utf8'), 'foreign replacement');
});

test('runner truncates append logs and excludes a second live Agent from the endpoint', { skip: !linux, timeout: 20000 }, async t => {
  const directory = await root(t), first = await agent(t, directory);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent') }); cleanAfter(t, () => client.close());
  const child = await client.start(command(directory, "process.stdout.write('x'.repeat(9*1024*1024)); setInterval(()=>console.log('tail-still-live'),50)"));
  const stateDirectory = join(directory, 'projects', '.agent-processes');
  await waitFor(async () => { const value = await readFile(join(stateDirectory, `${child.id}.out`)); return value.length < 8*1024*1024 && value.includes('tail-still-live'); });
  const contender = spawn(process.execPath, [new URL('./fixtures/survivable-agent.mjs', import.meta.url).pathname, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostic = ''; contender.stderr.on('data', bytes => { diagnostic += bytes; });
  assert.notEqual((await once(contender, 'exit'))[0], 0); assert.match(diagnostic, /locked/);
  assert.equal((await client.inspect()).processes.some(entry => entry.id === child.id && entry.running), true);
  await child.stop(); await first.kill('SIGTERM');
});

test('native retry adopts a host whose start reply was lost instead of starting a duplicate', { skip: !linux, timeout: 25000 }, async t => {
  const directory = await root(t), projects = join(directory, 'projects');
  const recipe = { name: '@zelavis/app', title: 'App', version: JSON.parse(await readFile(new URL('../services/zelavis-app/package.json', import.meta.url), 'utf8')).version, specifier: '@zelavis/app', runtimeKinds: ['native'] };
  const project = { id: 'sample', name: 'Sample', kind: 'zelavis', runtimeKind: 'native', recipe };
  await agent(t, directory);
  let client = await createAgentProcessClient({ directory: join(directory, 'agent') }); cleanAfter(t, () => client.close());
  let ambiguous = true;
  const delegated = { survivesControlPlaneRestart: true, attach: id => client.attach(id), close: () => client.close(),
    start: async (command, options) => {
      const child = await client.start(command, options);
      if (ambiguous) { ambiguous = false; await client.close(); throw Error('Injected lost start reply'); }
      return child;
    } };
  const driver = createNodeProcessProjectRuntime({ directory: projects, agent: delegated }); cleanAfter(t, () => driver.close());
  await driver.prepare(project, recipe);
  await assert.rejects(driver.start(project), /lost start reply/);
  const before = await record(join(directory, 'projects', '.agent-processes'));
  client = await createAgentProcessClient({ directory: join(directory, 'agent') });
  const started = await driver.start(project);
  assert.equal(started.status, 'running');
  assert.equal((await record(join(directory, 'projects', '.agent-processes'))).value.pid, before.value.pid);
  assert.equal((await readdir(join(directory, 'projects', '.agent-processes'))).filter(name => name.endsWith('.json')).length, 1);
  await driver.stop(project.id);
});

test('stop escalates a descendant after its group leader exits first', { skip: !linux }, async t => {
  const directory = await root(t), runner = createLocalAgentProcessRunner({ survivable: true, stateDirectory: join(directory, 'records'), graceMs: 100 });
  cleanAfter(t, () => runner.close());
  let descendant;
  const child = await runner.start(command(directory, `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']}); c.stdout.once('data',()=>console.log(c.pid)); setInterval(()=>{},1000);`), { onOutput: output => { if (/^\d+$/.test(output.line)) descendant = Number(output.line); } });
  await waitFor(() => descendant);
  assert.equal((await child.stop()).requested, true);
  await waitFor(async () => { try { const value = await readFile(`/proc/${descendant}/stat`, 'utf8'); return ['Z', 'X'].includes(value.slice(value.lastIndexOf(')') + 2).split(' ')[0]); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error; } });
});

test('unpublishable commands never execute and unpublished log files are pruned on recovery', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const runner = createLocalAgentProcessRunner({ survivable: true, stateDirectory });
  await assert.rejects(runner.start({ ...command(directory, `require('node:fs').writeFileSync('must-not-run','bad')`), workloadId: 'x'.repeat(129) }), /record bounds/);
  await assert.rejects(runner.start({ ...command(directory, ''), args: ['/old/engine/_node-project-runner.js'], stdin: 'pipe' }), /reconnectable private control/);
  await runner.detach();
  const replacement = createLocalAgentProcessRunner({ survivable: true, stateDirectory }); cleanAfter(t, () => replacement.close());
  assert.deepEqual(await replacement.recover(), []);
  await assert.rejects(readFile(join(directory, 'must-not-run')), { code: 'ENOENT' });
  assert.equal((await readdir(stateDirectory)).some(name => /\.(out|err|pending)$/.test(name)), false);
});

test('seed 3737844653: a real plan controller keeps its running process through repeated crash/rebind cuts', { skip: !linux, timeout: 30000 }, async t => {
  const directory = await root(t);
  let current = await agent(t, directory);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent'), reconnectTimeoutMs: 5000 }); cleanAfter(t, () => client.close());
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const host = makeAgentPlanHost({ runner: client, workloadId: 'sample', cwd: directory, commands: () => ({ node: process.execPath }),
    ports: { web: port }, baseEnvironment: {}, pollInterval: 25, stopGrace: 200,
    resolveSecret: () => Effect.succeed('unused') });
  const controller = await Effect.runPromise(makePlanController.pipe(Effect.provideService(PlanHost, host)));
  const events = [];
  const watch = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    const sub = yield* PubSub.subscribe(controller.events);
    for (;;) events.push(yield* PubSub.take(sub));
  })));
  cleanAfter(t, () => Effect.runPromise(Fiber.interrupt(watch)));
  const plan = { processes: [{ name: 'web', command: 'node', env: {}, dependsOn: [], args: ['-e', `require('node:http').createServer((q,s)=>s.end(String(process.pid))).listen(${port},'127.0.0.1')`], readiness: { port: 'web', timeoutMs: 5000 } }] };
  await Effect.runPromise(controller.reconcile(plan));
  const before = await (await fetch(`http://127.0.0.1:${port}`)).text();
  let seed = 3737844653;
  for (let turn = 0; turn < 4; turn++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    await current.kill(seed & 1 ? 'SIGTERM' : 'SIGKILL');
    assert.equal(await Effect.runPromise(controller.running), true);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), before);
    current = await agent(t, directory);
    await waitFor(async () => (await client.inspect()).readySupervisors > 0);
    assert.deepEqual((await Effect.runPromise(controller.reconcile(plan))).kept, ['web']);
  }
  assert.equal(events.some(event => event._tag === 'Exited'), false);
  await Effect.runPromise(controller.stop);
  assert.equal(events.some(event => event._tag === 'Exited'), false);
});

test('an expired placement is fenced before a recovered process can be rebound', { skip: !linux, timeout: 20000 }, async t => {
  const directory = await root(t), first = await agent(t, directory, true);
  const store = createLocalSqliteSystemStore({ filename: join(directory, 'system', 'zelavis.sqlite') }); cleanAfter(t, () => store.close());
  const authority = createProjectPlacementAuthority({ store, mayPlace: () => true });
  const granted = await authority.acquire({ projectId: 'sample', nodeId: 'local', ownerSession: 'expired-custody', expectedEpoch: 0, leaseMs: 1000 });
  assert.equal(granted.granted, true);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent') }); cleanAfter(t, () => client.close());
  const child = await client.start({ ...command(directory, 'setInterval(()=>{},1000)'), placement: { projectId: 'sample', nodeId: 'local', ownerSession: 'expired-custody', epoch: granted.placement.epoch } });
  const before = await record(join(directory, 'projects', '.agent-processes'));
  await first.kill('SIGKILL'); await delay(1200);
  await agent(t, directory, true);
  await child.exit;
  assert.equal(child.running, false);
  const current = await client.inspect(); assert.equal(current.processes.some(process => process.id === child.id && process.running), false);
  await waitFor(async () => { try { const value = await readFile(`/proc/${before.value.pid}/stat`, 'utf8'); return ['Z', 'X'].includes(value.slice(value.lastIndexOf(')') + 2).split(' ')[0]); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error; } });
});

test('exhausted reconnection reports unreachability while retaining the live process record', { skip: !linux, timeout: 10000 }, async t => {
  const directory = await root(t), first = await agent(t, directory);
  const client = await createAgentProcessClient({ directory: join(directory, 'agent'), reconnectTimeoutMs: 250 }); cleanAfter(t, () => client.close());
  const child = await client.start(command(directory, 'setInterval(()=>{},1000)'));
  const before = await record(join(directory, 'projects', '.agent-processes'));
  cleanAfter(t, () => { try { process.kill(-before.value.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  await first.kill('SIGKILL');
  const exit = await child.exit;
  assert.match(exit.reason, /Agent unreachable/); assert.equal(exit.code, null);
  assert.doesNotThrow(() => process.kill(before.value.pid, 0));
  assert.equal((await record(join(directory, 'projects', '.agent-processes'))).value.pid, before.value.pid);
});


test('a transient log read failure backs off and resumes supervision without fabricating an exit', { skip: !linux }, async t => {
  const directory = await root(t), stateDirectory = join(directory, 'records');
  const runner = createLocalAgentProcessRunner({ survivable: true, stateDirectory }); cleanAfter(t, () => runner.close());
  const output = [];
  const child = await runner.start(command(directory, "console.log('ready'); process.on('SIGUSR1',()=>console.log('after-io-error')); setInterval(()=>{},1000)"), { onOutput: value => output.push(value.line) });
  await waitFor(() => output.includes('ready'));
  const path = join(stateDirectory, `${child.id}.out`);
  let fd;
  for (const name of await readdir('/proc/self/fd')) {
    try { if (await readlink(`/proc/self/fd/${name}`) === path) { fd = Number(name); break; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(Number.isInteger(fd));
  const probe = await open(path, 'r'), prototype = Object.getPrototypeOf(probe), original = prototype.stat;
  let injected = false;
  prototype.stat = function(...args) {
    if (this.fd === fd && !injected) { injected = true; return Promise.reject(Object.assign(Error('Injected EIO'), { code: 'EIO' })); }
    return Reflect.apply(original, this, args);
  };
  cleanAfter(t, async () => { prototype.stat = original; await probe.close(); });
  await waitFor(() => injected);
  assert.equal(child.running, true);
  await child.signal('SIGUSR1');
  await waitFor(() => output.includes('after-io-error'));
  assert.equal((await child.stop()).requested, true);
});
