import { createLocalAgentProcessRunner } from '../../dist/adapters/_agent-process-runner.js';
import { createAgentProcessServer } from '../../dist/adapters/_agent-ipc.js';
import { join } from 'node:path';
import { runAgentCommand } from '../../dist/cli/agent.js';
const root = process.argv[2];
if (process.argv[3] === 'daemon') {
  await runAgentCommand({ dataDirectory: root, onReady: () => process.send({ ready: true }) });
  process.exit(0);
}
const runner = createLocalAgentProcessRunner({ stateDirectory: join(root, 'projects', '.agent-processes'), survivable: true, graceMs: 1000 });
const server = await createAgentProcessServer({ directory: join(root, 'agent'), runner });
process.on('SIGTERM', () => { server.close({ preserveProcesses: true }).then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
process.on('SIGINT', () => { server.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
process.send({ ready: true });
