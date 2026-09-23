import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentProcessClient, createAgentProcessServer } from "../dist/adapters/_agent-ipc.js";
import { createLocalAgentProcessRunner } from "../dist/adapters/_agent-process-runner.js";
import { createAgentRemoteEnvironment } from "../dist/adapters/_agent-remote-environment.js";

const waitFor = async (read, predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail("condition did not become true");
};

test("the Agent remote environment carries stdin, signals, output, exit, and replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-agent-environment-"));
  const local = createLocalAgentProcessRunner({ graceMs: 500 });
  const server = await createAgentProcessServer({ directory, runner: local });
  const client = await createAgentProcessClient({ directory });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const environment = createAgentRemoteEnvironment({ runner: client });
  const session = await environment.createSession({
    scope: { tenantId: "tenant", projectId: "project", laneId: "lane" },
  });
  const remoteProcess = await environment.startProcess(session.id, {
    command: process.execPath,
    args: ["-e", [
      "process.on('SIGUSR1', () => console.log('signalled'))",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', value => { console.log(`echo:${value.trim()}`); if (value.includes('quit')) process.exit(0) })",
      "console.log('ready')",
      "setInterval(() => {}, 1000)",
    ].join(";")],
    cwd: process.cwd(),
    env: {},
  });

  let page = await waitFor(
    () => environment.readEvents(session.id),
    (value) => value.events.some((event) => event.data === "ready"),
  );
  assert.equal(page.events[0].type, "status");
  assert.equal((await environment.operateProcess(remoteProcess.id, { type: "stdin", data: "hello\n" })).accepted, true);
  page = await waitFor(
    () => environment.readEvents(session.id),
    (value) => value.events.some((event) => event.data === "echo:hello"),
  );
  assert.equal((await environment.operateProcess(remoteProcess.id, { type: "signal", data: "SIGUSR1" })).accepted, true);
  page = await waitFor(
    () => environment.readEvents(session.id),
    (value) => value.events.some((event) => event.data === "signalled"),
  );
  const beforeExit = page.cursor;
  await environment.operateProcess(remoteProcess.id, { type: "stdin", data: "quit\n" });
  const exitPage = await waitFor(
    () => environment.readEvents(session.id, { after: beforeExit }),
    (value) => value.events.some((event) => event.type === "exit"),
  );
  assert.equal(exitPage.events.at(-1).status, "exited");
  assert.equal(exitPage.events.at(-1).exitCode, 0);
});

test("an active environment session reattaches and replays Agent output", async () => {
  let outputListener;
  let writes = "";
  const exit = new Promise(() => {});
  const handle = {
    id: "p7",
    workloadId: "environment:session-1",
    running: true,
    exit,
    stop: async () => ({ code: 0, signal: null, requested: true }),
    write: async (data) => { writes += data; return true; },
    signal: async () => true,
    listen: (listener) => { outputListener = listener; },
  };
  const runner = {
    name: "fake-agent",
    survivesControlPlaneRestart: true,
    start: async () => handle,
    attach: async (workloadId) => {
      assert.equal(workloadId, "environment:session-1");
      return [{ process: handle, replay: [{ stream: "stdout", line: "while-away" }] }];
    },
    close: async () => {},
  };
  const environment = createAgentRemoteEnvironment({ runner });
  await environment.resumeSession({ id: "session-1", status: "active", createdAt: "2026-01-01T00:00:00Z" });
  const replay = await environment.readEvents("session-1");
  assert.equal(replay.events.some((event) => event.data === "while-away"), true);
  assert.equal((await environment.operateProcess("session-1:p7", { type: "stdin", data: "next\n" })).accepted, true);
  assert.equal(writes, "next\n");
  outputListener({ stream: "stderr", line: "live" });
  assert.equal((await environment.readEvents("session-1", { after: replay.cursor })).events[0].data, "live");

  const replacement = createAgentRemoteEnvironment({ runner });
  await replacement.resumeSession({ id: "session-1", status: "active", createdAt: "2026-01-01T00:00:00Z" });
  const resumed = await replacement.readEvents("session-1", { after: replay.cursor });
  assert.equal(resumed.truncated, true);
  assert.equal(resumed.events.some((event) => event.data === "while-away"), true);
});

test("event replay reports when its requested cursor fell out of the retained window", async () => {
  const listeners = {};
  const handle = {
    workloadId: "session",
    running: true,
    exit: new Promise(() => {}),
    stop: async () => ({ code: 0, signal: null, requested: true }),
  };
  const runner = {
    name: "fake",
    start: async (_command, options) => {
      listeners.output = options.onOutput;
      return handle;
    },
    close: async () => {},
  };
  const environment = createAgentRemoteEnvironment({ runner, eventLimit: 2 });
  const session = await environment.createSession({});
  await environment.startProcess(session.id, { command: "agent", cwd: "/workspace" });
  listeners.output({ stream: "stdout", line: "one" });
  listeners.output({ stream: "stdout", line: "two" });
  listeners.output({ stream: "stdout", line: "three" });
  const page = await environment.readEvents(session.id, { after: "e1" });
  assert.equal(page.truncated, true);
  assert.deepEqual(page.events.map((event) => event.data), ["two", "three"]);
});
