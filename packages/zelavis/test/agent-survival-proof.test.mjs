// Early plan section 0 proof. Passing this does NOT implement runner adoption,
// bounded log tailing, durable authority or client reconnection.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isAlive, processAgeMs } from '../dist/adapters/_agent-process-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/agent-survival-proof.mjs', import.meta.url));
const posix = process.platform !== 'win32';
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  do {
    if (await check()) return;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('Process proof did not reach its condition within 5 seconds');
}
async function source(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function signal(pid, value) {
  try { process.kill(pid, value); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function owner(t, mode) {
  // No scratch directories: files live beside this test and are always removed.
  const prefix = fileURLToPath(new URL(`./.agent-survival-${randomUUID()}`, import.meta.url));
  const child = spawn(process.execPath, [fixture, mode, prefix], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = `${diagnostics}${chunk}`.slice(-8192); });
  let workload;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (!workload && mode === 'files') {
      const persisted = await source(`${prefix}.json`);
      if (persisted) workload = JSON.parse(persisted);
    }
    if (workload) signal(mode === 'files' ? -workload.pid : workload.pid, 'SIGKILL');
    await Promise.all(['out', 'err', 'json', 'eof'].map(suffix => rm(`${prefix}.${suffix}`, { force: true })));
  });
  const received = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  try { [workload] = await received; }
  catch (error) { throw Error(`Proof owner did not start: ${diagnostics}`, { cause: error }); }
  return { prefix, workload, child, async kill() {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  } };
}

// Minimal second-runner prototype: the *existing* 30-second ps-age guard is
// deliberately used so this experiment also exposes its limits. No new claim
// of strong PID identity or single-writer authority is made here.
async function adopt(prefix) {
  const record = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  const matches = async () => {
    if (!isAlive(record.pid)) return false;
    const age = await processAgeMs(record.pid);
    return age !== undefined && Math.abs(age - (Date.now() - Date.parse(record.startedAt))) <= 30_000;
  };
  if (!await matches()) return undefined;
  return { record, replay: async () => source(`${prefix}.out`),
    async signal(value) {
      if (!await matches()) return false;
      signal(-record.pid, value);
      return true;
    } };
}

test('file output survives owner SIGKILL; another runner replays and signals the same process', { skip: !posix }, async t => {
  const first = await owner(t, 'files');
  const { prefix, workload } = first;
  await waitFor(async () => (await source(`${prefix}.out`)).includes(`ready:${workload.pid}`));
  const before = (await stat(`${prefix}.out`)).size;
  await first.kill();
  await waitFor(async () => (await stat(`${prefix}.out`)).size > before);
  assert.equal(isAlive(workload.pid), true);
  const next = await adopt(prefix);
  assert.ok(next);
  assert.equal(next.record.pid, workload.pid);
  assert.match(await next.replay(), new RegExp(`ready:${workload.pid}`));
  assert.equal(await next.signal('SIGUSR1'), true);
  await waitFor(async () => (await source(`${prefix}.err`)).includes('signal-received'));
  assert.equal(await next.signal('SIGTERM'), true);
  await waitFor(async () => await processAgeMs(workload.pid) === undefined);
});

test('existing age check refuses a clearly reused PID without signalling it', { skip: !posix }, async t => {
  const first = await owner(t, 'files');
  await first.kill();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${first.prefix}.json`, JSON.stringify({ ...first.workload,
    startedAt: new Date(Date.now() - 86400_000).toISOString() }));
  assert.equal(await adopt(first.prefix), undefined);
  assert.equal(isAlive(first.workload.pid), true);
});

test('negative control: the former stdin command protocol sees EOF when its Agent dies', { skip: !posix }, async t => {
  const first = await owner(t, 'local-pipe');
  await first.kill();
  await waitFor(async () => (await source(`${first.prefix}.eof`)) === 'closed');
  await waitFor(async () => await processAgeMs(first.workload.pid) === undefined);
});
