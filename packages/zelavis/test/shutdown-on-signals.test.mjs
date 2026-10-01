import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { shutdownOnSignals } from "../dist/runtimes/node.js";

function fakeProcess() {
  const events = new EventEmitter();
  const exits = [];
  return {
    exits,
    emit: (signal) => events.emit(signal),
    on: (signal, handler) => events.on(signal, handler),
    off: (signal, handler) => events.off(signal, handler),
    exit: (code) => { exits.push(code); },
    listeners: (signal) => events.listenerCount(signal),
  };
}

const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };

test("a repeated signal does not interrupt a shutdown that is still running", async () => {
  // Ctrl-C reaches a process twice under a dev script that forwards it. With a
  // one-shot handler the second took Node's default action and killed the
  // process before the Projects had stopped and their placements were released.
  const proc = fakeProcess();
  const finish = gate();
  let started = 0;
  const handle = shutdownOnSignals(async () => { started += 1; await finish.promise; }, { process: proc, log: () => {} });

  proc.emit("SIGINT");
  proc.emit("SIGINT");
  proc.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1, "one shutdown, however many signals");
  assert.deepEqual(proc.exits, [], "not exited while it runs");
  assert.ok(proc.listeners("SIGINT") > 0, "the handler stays registered");

  finish.open();
  await handle.shutdown();
  assert.deepEqual(proc.exits, [0]);
});

test("closing the terminal (SIGHUP) shuts down as well", async () => {
  const proc = fakeProcess();
  let ran = false;
  shutdownOnSignals(async () => { ran = true; }, { process: proc, log: () => {} });
  proc.emit("SIGHUP");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true);
  assert.deepEqual(proc.exits, [0]);
});

test("a shutdown that fails is reported and exits non-zero", async () => {
  const proc = fakeProcess();
  const logged = [];
  const handle = shutdownOnSignals(async () => { throw new Error("stop failed"); }, { process: proc, log: (m) => logged.push(m) });
  await handle.shutdown();
  assert.deepEqual(proc.exits, [1]);
  assert.match(logged.join("\n"), /stop failed/);
});

test("a shutdown that never finishes is cut off", async () => {
  const proc = fakeProcess();
  const logged = [];
  shutdownOnSignals(() => new Promise(() => {}), { process: proc, forceAfterMs: 20, log: (m) => logged.push(m) });
  proc.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(proc.exits, [1]);
  assert.match(logged.join("\n"), /did not finish/);
});

test("disposing removes the handlers", () => {
  const proc = fakeProcess();
  const handle = shutdownOnSignals(async () => {}, { process: proc });
  assert.equal(proc.listeners("SIGINT"), 1);
  handle.dispose();
  assert.equal(proc.listeners("SIGINT"), 0);
});
