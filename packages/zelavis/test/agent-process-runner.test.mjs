import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalAgentProcessRunner,
  MAX_AGENT_PROCESS_LINE_LENGTH,
} from "../dist/adapters/_agent-process-runner.js";

async function script(source) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-"));
  const file = join(directory, "child.mjs");
  await writeFile(file, source, "utf8");
  return { directory, file };
}

function startOptions() {
  const output = [];
  const exits = [];
  return {
    output,
    exits,
    listeners: {
      onOutput: (line) => output.push(line),
      onExit: (exit) => exits.push(exit),
    },
  };
}

async function run(runner, source, listeners) {
  const { directory, file } = await script(source);
  return runner.start(
    {
      workloadId: "test-project",
      executable: process.execPath,
      args: [file],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
    },
    listeners,
  );
}

test("output reaches the caller as complete lines", async () => {
  const runner = createLocalAgentProcessRunner();
  const { output, listeners } = startOptions();

  const child = await run(
    runner,
    `
      process.stdout.write("first\\nsec");
      process.stdout.write("ond\\n");
      process.stderr.write("problem\\n");
    `,
    listeners,
  );
  await child.exit;

  // A line split across two writes is one line, not two. Every driver was
  // reassembling this separately before, and one of them did not.
  assert.deepEqual(output, [
    { stream: "stdout", line: "first" },
    { stream: "stdout", line: "second" },
    { stream: "stderr", line: "problem" },
  ]);
});

test("an over-long line is truncated once, however the stream is chunked", async () => {
  const runner = createLocalAgentProcessRunner();
  const { output, listeners } = startOptions();

  const child = await run(
    runner,
    `process.stdout.write("x".repeat(${MAX_AGENT_PROCESS_LINE_LENGTH + 1024}));
     process.stdout.write("\\nafter\\n");`,
    listeners,
  );
  await child.exit;

  const lines = output.map((entry) => entry.line);

  // Exactly one entry for the long line, not one per chunk the operating
  // system happened to deliver — and it appears whether the cap is reached
  // mid-line or on a line that arrived complete. Checking only the held
  // remainder made this depend on chunk boundaries, which passed locally and
  // failed on CI.
  const truncated = lines.filter((line) => line.startsWith("x"));
  assert.equal(truncated.length, 1, JSON.stringify(lines.map((l) => l.slice(0, 40))));
  assert.match(truncated[0], /… \(truncated, line exceeded \d+ characters\)$/);
  assert.equal(
    truncated[0].indexOf("…"),
    MAX_AGENT_PROCESS_LINE_LENGTH,
    "the head of the line is kept",
  );

  // The stream recovers: what follows the truncated line is delivered whole.
  assert.ok(lines.includes("after"), JSON.stringify(lines.map((l) => l.slice(0, 40))));
});

test("the same over-long line trickled in small writes gives the same result", async () => {
  const runner = createLocalAgentProcessRunner();
  const { output, listeners } = startOptions();

  // Forces the other path: the cap is reached while the line is still partial,
  // across many reads, rather than on one chunk that already contains the
  // terminator. Both must produce one truncated entry and then "after".
  const child = await run(
    runner,
    `const chunk = "x".repeat(4096);
     let written = 0;
     const timer = setInterval(() => {
       process.stdout.write(chunk);
       written += 1;
       if (written === 20) {
         clearInterval(timer);
         process.stdout.write("\\nafter\\n");
       }
     }, 1);`,
    listeners,
  );
  await child.exit;

  const lines = output.map((entry) => entry.line);
  const truncated = lines.filter((line) => line.startsWith("x"));

  assert.equal(truncated.length, 1, JSON.stringify(lines.map((l) => l.slice(0, 40))));
  assert.match(truncated[0], /… \(truncated, line exceeded \d+ characters\)$/);
  assert.ok(lines.includes("after"), JSON.stringify(lines.map((l) => l.slice(0, 40))));
});

test("a line within the cap is delivered untouched", async () => {
  const runner = createLocalAgentProcessRunner();
  const { output, listeners } = startOptions();

  const child = await run(
    runner,
    `process.stdout.write("y".repeat(${MAX_AGENT_PROCESS_LINE_LENGTH}) + "\\n");`,
    listeners,
  );
  await child.exit;

  assert.equal(output.length, 1);
  assert.equal(output[0].line.length, MAX_AGENT_PROCESS_LINE_LENGTH);
  assert.doesNotMatch(output[0].line, /truncated/);
});

test("an exit is reported with its code, and marked unrequested", async () => {
  const runner = createLocalAgentProcessRunner();
  const { exits, listeners } = startOptions();

  const child = await run(runner, `process.exit(3);`, listeners);
  const exit = await child.exit;

  assert.deepEqual(exit, { code: 3, signal: null, requested: false });
  assert.deepEqual(exits, [exit]);
  assert.equal(child.running, false);
});

test("stop resolves only once the process is actually gone", async () => {
  const runner = createLocalAgentProcessRunner();
  const child = await run(runner, `setInterval(() => {}, 1000);`);

  assert.equal(child.running, true);
  const exit = await child.stop();

  // A driver that stops and then reports "stopped" must not be describing a
  // process that is still running.
  assert.equal(child.running, false);
  assert.equal(exit.requested, true);
  assert.equal(exit.signal, "SIGTERM");
});

test("a process that ignores SIGTERM is escalated to SIGKILL", async () => {
  const runner = createLocalAgentProcessRunner();

  // Waits for the child to say it is ready before signalling. `start` resolves
  // when the process was spawned, which is before Node has run a line of the
  // script — signalling then would kill it by default action and prove
  // nothing about the escalation.
  let ready;
  const running = new Promise((resolveReady) => {
    ready = resolveReady;
  });

  const child = await run(
    runner,
    `process.on("SIGTERM", () => {});
     setInterval(() => {}, 1000);
     process.stdout.write("ready\\n");`,
    { onOutput: ({ line }) => { if (line === "ready") ready(); } },
  );
  await running;

  // Short grace so the test does not wait out the default.
  const exit = await child.stop({ graceMs: 200 });

  assert.equal(exit.signal, "SIGKILL");
  assert.equal(exit.requested, true);
});

test("stopping twice returns the same exit rather than signalling a dead process", async () => {
  const runner = createLocalAgentProcessRunner();
  const child = await run(runner, `setInterval(() => {}, 1000);`);

  const first = await child.stop({ graceMs: 200 });
  const second = await child.stop({ graceMs: 200 });

  assert.deepEqual(second, first);
});

test("a process that cannot be started reports an exit rather than hanging", async () => {
  const runner = createLocalAgentProcessRunner();
  const { directory } = await script("");

  const child = await runner.start({
    workloadId: "test-project",
    executable: join(directory, "does-not-exist"),
    cwd: directory,
    env: {},
  });

  // A spawn failure never produces an `exit` event, so a driver awaiting one
  // would wait forever.
  const exit = await child.exit;
  assert.equal(exit.code, null);
  assert.equal(child.running, false);
});

test("closing the runner stops everything it started", async () => {
  const runner = createLocalAgentProcessRunner({ graceMs: 200 });
  const first = await run(runner, `setInterval(() => {}, 1000);`);
  const second = await run(runner, `setInterval(() => {}, 1000);`);

  await runner.close();

  assert.equal(first.running, false);
  assert.equal(second.running, false);
});

test("the child gets only the environment it was given", async () => {
  const runner = createLocalAgentProcessRunner();
  const { output, listeners } = startOptions();

  process.env.ZELAVIS_AGENT_RUNNER_LEAK_CHECK = "platform-secret";
  try {
    const child = await run(
      runner,
      `process.stdout.write(JSON.stringify(process.env.ZELAVIS_AGENT_RUNNER_LEAK_CHECK ?? null) + "\\n");`,
      listeners,
    );
    await child.exit;
  } finally {
    delete process.env.ZELAVIS_AGENT_RUNNER_LEAK_CHECK;
  }

  // Inheriting `process.env` wholesale would hand a Project the Platform's
  // bootstrap token, provider credentials, and signing keys.
  assert.deepEqual(
    output.map((entry) => entry.line),
    ["null"],
  );
});
