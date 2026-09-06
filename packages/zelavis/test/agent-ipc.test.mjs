import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentSocketPath,
  agentTokenPath,
  createAgentProcessClient,
  createAgentProcessServer,
  readAgentToken,
} from "../dist/adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";

const closers = new Set();
after(async () => {
  for (const close of closers) await close().catch(() => undefined);
});

async function endpoint() {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-ipc-"));
  const runner = createLocalAgentProcessRunner({
    stateDirectory: join(directory, "state"),
    graceMs: 500,
  });
  const server = await createAgentProcessServer({ directory, runner });
  closers.add(() => server.close());
  return { directory, server };
}

async function client(directory) {
  const agent = await createAgentProcessClient({ directory });
  closers.add(() => agent.close());
  return agent;
}

async function script(source) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-ipc-run-"));
  const file = join(directory, "child.mjs");
  await writeFile(file, source, "utf8");
  return { directory, file };
}

function command(directory, file, workloadId = "ipc-project") {
  return {
    workloadId,
    executable: process.execPath,
    args: [file],
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
  };
}

test("a Project runs through the Agent and reports its output and exit", async () => {
  const { directory } = await endpoint();
  const agent = await client(directory);

  const { directory: cwd, file } = await script(
    `process.stdout.write("ready\\n"); process.stderr.write("noted\\n"); process.exit(7);`,
  );

  const lines = [];
  const child = await agent.start(command(cwd, file), {
    onOutput: (output) => lines.push(output),
  });
  const exit = await child.exit;

  // The whole point of putting the drivers behind the contract first: what
  // crosses the socket is the same shape they already consume.
  assert.deepEqual(lines, [
    { stream: "stdout", line: "ready" },
    { stream: "stderr", line: "noted" },
  ]);
  assert.equal(exit.code, 7);
  assert.equal(exit.requested, false);
  assert.equal(child.running, false);
});

test("stopping through the Agent resolves once the process is gone", async () => {
  const { directory } = await endpoint();
  const agent = await client(directory);
  const { directory: cwd, file } = await script(`setInterval(() => {}, 1000);`);

  const child = await agent.start(command(cwd, file));
  assert.equal(child.running, true);

  const exit = await child.stop();

  assert.equal(child.running, false);
  assert.equal(exit.requested, true);
});

test("the Agent keeps running a Project after the Platform disconnects", async () => {
  const { directory } = await endpoint();
  const agent = await client(directory);
  const { directory: cwd, file } = await script(`setInterval(() => {}, 1000);`);

  const child = await agent.start(command(cwd, file));
  const pid = await pidOf(directory, cwd);

  // Disconnecting is not stopping. A Platform shutting down is not a reason to
  // take an operator's Projects offline — that is what supervising the Agent
  // separately buys.
  await agent.close();
  await new Promise((wait) => setTimeout(wait, 200));

  assert.equal(alive(pid), true);

  // The caller's promise settles rather than hanging, and says nothing it does
  // not know: the process is still running, but this client cannot see it.
  const exit = await child.exit;
  assert.deepEqual(exit, { code: null, signal: null, requested: false });

  // Still running, and now reclaimable — which the next test covers. Cleaned
  // up here so it does not outlive the suite.
  process.kill(pid, "SIGKILL");
});

test("a Platform that vanished has its processes reclaimed by the next one", async () => {
  const { directory } = await endpoint();
  const first = await client(directory);
  const { directory: cwd, file } = await script(`setInterval(() => {}, 1000);`);

  await first.start(command(cwd, file, "abandoned"));
  const pid = await pidOf(directory, cwd);

  // The Platform goes away without stopping anything. Its processes are still
  // running here, but no client has a handle to them: nothing can drive them,
  // and re-attachment does not exist yet.
  await first.close();
  await new Promise((wait) => setTimeout(wait, 100));
  assert.equal(alive(pid), true);

  const second = await client(directory);
  assert.equal(await second.reclaim(), 1);

  // The durable record names this Agent as owner and this Agent is alive, so a
  // record-only reclaim would skip these forever. The connection that asked for
  // them is what makes them reclaimable.
  await new Promise((wait) => setTimeout(wait, 200));
  assert.equal(alive(pid), false);
});

test("a live Platform's processes are not reclaimed out from under it", async () => {
  const { directory } = await endpoint();
  const holder = await client(directory);
  const other = await client(directory);
  const { directory: cwd, file } = await script(`setInterval(() => {}, 1000);`);

  const child = await holder.start(command(cwd, file, "held"));
  assert.equal(await other.reclaim(), 0);
  assert.equal(child.running, true);

  await child.stop();
});

test("a connection without the token is refused", async () => {
  const { directory } = await endpoint();

  const refused = await new Promise((resolveRefused) => {
    const socket = connect(agentSocketPath(directory), () => {
      socket.write(`${JSON.stringify({ type: "hello", token: "wrong" })}\n`);
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolveRefused(received));
    socket.on("error", () => resolveRefused(received));
  });

  assert.match(refused, /authentication failed/);
});

test("a command before the handshake is refused", async () => {
  const { directory } = await endpoint();

  const refused = await new Promise((resolveRefused) => {
    const socket = connect(agentSocketPath(directory), () => {
      // Skipping the handshake must not be a way to skip authentication.
      socket.write(`${JSON.stringify({ id: "1", type: "reclaim" })}\n`);
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("close", () => resolveRefused(received));
    socket.on("error", () => resolveRefused(received));
  });

  assert.match(refused, /authentication failed/);
});

test("the socket and its token are readable only by the Agent's user", async () => {
  const { directory } = await endpoint();

  // The token is the second lock. The first is that reaching the socket at all
  // means being the user the Agent runs as.
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(agentTokenPath(directory))).mode & 0o777, 0o600);
  assert.equal((await stat(agentSocketPath(directory))).mode & 0o777, 0o600);
});

test("connecting where no Agent listens says so", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-absent-"));
  await writeFile(agentTokenPath(directory), "token\n", { mode: 0o600 });

  await assert.rejects(
    createAgentProcessClient({ directory, connectTimeoutMs: 1_000 }),
    // A Project that fails to start because no Agent is running must not read
    // as a broken Project.
    /ENOENT|No Agent is listening/,
  );
});

test("an Agent restarted over a stale socket file listens again", async () => {
  const { directory, server } = await endpoint();
  const token = await readAgentToken(directory);

  // A crashed Agent leaves its socket file behind. It is not a listener, and
  // treating it as one fails the restart with EADDRINUSE.
  await server.close();
  await writeFile(agentSocketPath(directory), "", { mode: 0o600 });

  const runner = createLocalAgentProcessRunner({ graceMs: 500 });
  const restarted = await createAgentProcessServer({ directory, runner });
  closers.add(() => restarted.close());

  assert.equal(restarted.token, token, "the token survives a restart");
  const agent = await client(directory);
  assert.equal(await agent.reclaim(), 0);
});

/** The pid of the only child the Agent started, read from its state records. */
async function pidOf(directory, cwd) {
  const { readdir, readFile } = await import("node:fs/promises");
  const stateDirectory = join(directory, "state");
  const names = await readdir(stateDirectory);
  for (const name of names) {
    const record = JSON.parse(
      await readFile(join(stateDirectory, name), "utf8"),
    );
    if (record.cwd === cwd || record.executable === process.execPath) {
      return record.pid;
    }
  }
  throw new Error("no process record found");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

test("the Agent runs as its own process, outliving the Platform that drove it", async () => {
  // The in-process tests above prove the protocol. This one proves the shape
  // that makes the protocol worth having: a separate, separately supervised
  // process, spoken to over a socket by a Platform that then dies.
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-proc-"));
  const agentScript = join(directory, "agent.mjs");
  await writeFile(
    agentScript,
    `import { createAgentProcessServer } from "${new URL("../dist/adapters/_agent-ipc.js", import.meta.url).href}";
     import { createLocalAgentProcessRunner } from "${new URL("../dist/adapters/_agent-process-runner.js", import.meta.url).href}";
     const server = await createAgentProcessServer({
       directory: ${JSON.stringify(join(directory, "endpoint"))},
       runner: createLocalAgentProcessRunner({ stateDirectory: ${JSON.stringify(join(directory, "state"))}, graceMs: 500 }),
     });
     process.stdout.write("listening\\n");
     process.on("SIGTERM", async () => { await server.close(); process.exit(0); });
     setInterval(() => {}, 1000);`,
    "utf8",
  );

  const agentProcess = spawn(process.execPath, [agentScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  closers.add(async () => {
    agentProcess.kill("SIGKILL");
  });

  await new Promise((resolveListening, rejectListening) => {
    const timer = setTimeout(
      () => rejectListening(new Error("the Agent process never listened")),
      10_000,
    );
    agentProcess.stdout.on("data", (chunk) => {
      if (!chunk.toString("utf8").includes("listening")) return;
      clearTimeout(timer);
      resolveListening();
    });
    agentProcess.stderr.on("data", (chunk) => {
      clearTimeout(timer);
      rejectListening(new Error(chunk.toString("utf8")));
    });
  });

  const endpointDirectory = join(directory, "endpoint");
  const agent = await createAgentProcessClient({ directory: endpointDirectory });
  const { directory: cwd, file } = await script(
    `process.stdout.write("up\\n"); setInterval(() => {}, 1000);`,
  );

  const seen = [];
  const child = await agent.start(command(cwd, file, "separate"), {
    onOutput: (output) => seen.push(output.line),
  });

  await new Promise((wait) => setTimeout(wait, 300));
  assert.deepEqual(seen, ["up"], "output crossed a real process boundary");

  await child.stop();
  assert.equal(child.running, false);

  await agent.close();
  agentProcess.kill("SIGTERM");
  await new Promise((resolveExit) => agentProcess.once("exit", resolveExit));
});
