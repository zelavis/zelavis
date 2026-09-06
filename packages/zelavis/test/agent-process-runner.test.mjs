import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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


/**
 * A process started by a "previous Platform".
 *
 * Spawned directly rather than through the runner, then recorded by hand with
 * an owner pid that is not this process — which is exactly the state a crashed
 * Platform leaves behind, and the only way to reproduce it without killing the
 * test runner.
 */
const spawnedOrphans = new Set();

// Belt and braces: whatever a test does or fails to do, no stand-in process
// outlives the suite. A leaked one would be indistinguishable from the very
// leak these tests exist to prevent.
after(() => {
  for (const child of spawnedOrphans) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

async function orphan(stateDirectory, workloadId) {
  const { directory, file } = await script(`setInterval(() => {}, 1000);`);
  const { spawn } = await import("node:child_process");
  const process_ = spawn(process.execPath, [file], {
    cwd: directory,
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  // Never holds the test runner's event loop open: it stands in for a process
  // this Node process does not own.
  process_.unref();
  spawnedOrphans.add(process_);
  process_.once("exit", () => spawnedOrphans.delete(process_));
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, `${workloadId}.json`),
    JSON.stringify({
      workloadId,
      pid: process_.pid,
      executable: process.execPath,
      startedAt: new Date().toISOString(),
      // A pid that cannot be alive: the previous Platform is gone.
      ownerPid: 2147483646,
    }),
  );
  return process_;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

test("a process left by a crashed Platform is stopped before its workload restarts", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));
  // `run` starts everything as "test-project", which is the workload whose
  // leftover would hold the port a replacement needs.
  const leftover = await orphan(stateDirectory, "test-project");

  assert.equal(alive(leftover.pid), true);

  const runner = createLocalAgentProcessRunner({ stateDirectory, graceMs: 500 });
  const replacement = await run(runner, `setInterval(() => {}, 1000);`);

  // Starting the same workload is the moment a leftover does damage: it still
  // holds the port and still answers requests the Platform believes it serves.
  assert.equal(alive(leftover.pid), false);
  assert.equal(replacement.running, true);

  await replacement.stop({ graceMs: 500 });
});

test("processes of a workload that is never restarted are swept too", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));
  // A Project the operator stopped and never started again. Reclaiming only
  // the workload being started would leave this running forever — which is the
  // shape the leak was found in: daemons still running days after the crash.
  const forgotten = await orphan(stateDirectory, "some-other-project");

  const runner = createLocalAgentProcessRunner({ stateDirectory, graceMs: 500 });
  const unrelated = await run(runner, `setInterval(() => {}, 1000);`);

  assert.equal(alive(forgotten.pid), false);

  await unrelated.stop({ graceMs: 500 });
});

test("reclaim leaves another live Platform's processes alone", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));
  const other = await orphan(stateDirectory, "other-project");

  // Rewrite the record so its owner is this very process — a Platform that is
  // demonstrably still running. Killing a live installation's Projects is not
  // how "two Platforms on one data directory" should be discovered.
  const [name] = await readdir(stateDirectory);
  const record = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
  await writeFile(
    join(stateDirectory, name),
    JSON.stringify({ ...record, ownerPid: process.pid }),
  );

  const runner = createLocalAgentProcessRunner({ stateDirectory, graceMs: 500 });
  assert.equal(await runner.reclaim(), 0);
  assert.equal(alive(other.pid), true);

  other.kill("SIGKILL");
});

test("a recycled pid is not signalled", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));
  const survivor = await orphan(stateDirectory, "recycled");

  // The same live pid, recorded as having started a day ago. That is what pid
  // reuse looks like from here: the recorded process died, the id was handed to
  // something else, and signalling on the id alone would kill a stranger.
  const [name] = await readdir(stateDirectory);
  const record = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
  await writeFile(
    join(stateDirectory, name),
    JSON.stringify({
      ...record,
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }),
  );

  const runner = createLocalAgentProcessRunner({ stateDirectory, graceMs: 500 });
  assert.equal(await runner.reclaim(), 0);
  assert.equal(alive(survivor.pid), true);

  // The record is dropped rather than kept: it describes nothing this Platform
  // can act on, now or later.
  assert.deepEqual(await readdir(stateDirectory), []);

  survivor.kill("SIGKILL");
});

test("a process that renamed itself is still recognised", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));

  // Daemons rewrite their own argv: php-fpm reports itself as
  // `php-fpm: master process (...)` and nginx as `nginx: master process ...`,
  // neither containing the path that was executed. Matching on the command line
  // left a real php-fpm running through a reclaim.
  const { directory, file } = await script(
    `process.title = "totally-different-name"; setInterval(() => {}, 1000);`,
  );
  const { spawn } = await import("node:child_process");
  const renamed = spawn(process.execPath, [file], {
    cwd: directory,
    stdio: ["ignore", "ignore", "ignore"],
  });
  renamed.unref();
  spawnedOrphans.add(renamed);

  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, "renamed.json"),
    JSON.stringify({
      workloadId: "renamed",
      pid: renamed.pid,
      executable: process.execPath,
      startedAt: new Date().toISOString(),
      ownerPid: 2147483646,
    }),
  );

  const runner = createLocalAgentProcessRunner({ stateDirectory, graceMs: 500 });
  assert.equal(await runner.reclaim(), 1);
  assert.equal(alive(renamed.pid), false);
});

test("a record is removed when its process exits normally", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "zelavis-agent-state-"));
  const runner = createLocalAgentProcessRunner({ stateDirectory });

  const child = await run(runner, `process.exit(0);`);
  await child.exit;
  // The removal is fire-and-forget on the exit path.
  await new Promise((wait) => setTimeout(wait, 100));

  // A record left behind would have a later Platform chasing a dead pid — or a
  // pid the operating system has since handed to something else.
  assert.deepEqual(await readdir(stateDirectory), []);
});

test("a runner with no state directory records nothing and reclaims nothing", async () => {
  const runner = createLocalAgentProcessRunner();
  assert.equal(await runner.reclaim(), 0);

  const child = await run(runner, `process.exit(0);`);
  await child.exit;
});
