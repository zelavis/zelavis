// OS primitive experiment, not the production survivable runner from plan step 1.
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { createLocalAgentProcessRunner } from '../../dist/adapters/_agent-process-runner.js';

const [mode, prefix] = process.argv.slice(2);
const source = `
  process.on('SIGUSR1', () => console.error('signal-received'));
  console.log('ready:' + process.pid);
  setInterval(() => console.log('tick'), 25);
`;
if (mode === 'files') {
  const stdout = openSync(`${prefix}.out`, 'ax', 0o600);
  const stderr = openSync(`${prefix}.err`, 'ax', 0o600);
  const child = spawn(process.execPath, ['-e', source], {
    detached: true, stdio: ['ignore', stdout, stderr], env: {},
  });
  closeSync(stdout);
  closeSync(stderr);
  child.once('error', error => { throw error; });
  child.once('spawn', () => {
    const record = { processId: prefix.split('/').at(-1), pid: child.pid,
      ownerPid: process.pid, executable: process.execPath, args: ['-e', source],
      cwd: process.cwd(), startedAt: new Date().toISOString() };
    writeFileSync(`${prefix}.json`, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    process.send(record);
  });
} else if (mode === 'local-pipe') {
  // Uses the production runner. A stdin consumer exits on EOF just as the
  // native App host does through serveNodeRuntimeCommands.
  const runner = createLocalAgentProcessRunner();
  await runner.start({ workloadId: 'proof', executable: process.execPath,
    cwd: process.cwd(), env: {}, stdin: 'pipe', args: ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { Effect } from ${JSON.stringify(import.meta.resolve('effect'))};
      import { serveNodeRuntimeCommands } from ${JSON.stringify(new URL('../../dist/adapters/_node-runtime-commands.js', import.meta.url).href)};
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const finished = yield* serveNodeRuntimeCommands({ input: process.stdin,
          emit: () => {}, command: () => Effect.succeed({}) });
        console.log('ready:' + process.pid);
        yield* finished;
        writeFileSync(${JSON.stringify(`${prefix}.eof`)}, 'closed');
      })));
    `] }, { onOutput: ({ line }) => {
      if (line.startsWith('ready:')) process.send({ pid: Number(line.slice(6)) });
    } });
} else {
  throw Error(`Unknown proof mode: ${mode}`);
}
