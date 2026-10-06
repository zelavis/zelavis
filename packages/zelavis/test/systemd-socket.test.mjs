import assert from "node:assert/strict";
import test from "node:test";
import { takeInheritedSocket } from "../dist/adapters/_systemd-socket.js";

test("the inherited socket is taken only by the process systemd named, and the variables are cleared", () => {
  const env = { LISTEN_PID: "42", LISTEN_FDS: "1", LISTEN_FDNAMES: "x", KEEP: "1" };
  assert.deepEqual(takeInheritedSocket(env, 42), { fd: 3 });
  assert.deepEqual(env, { KEEP: "1" });
});

test("a variable inherited from another process, or no socket, yields none", () => {
  for (const env of [{ LISTEN_PID: "7", LISTEN_FDS: "1" }, { LISTEN_PID: "42", LISTEN_FDS: "0" }, { LISTEN_PID: "42" }, {}]) {
    assert.equal(takeInheritedSocket(env, 42), undefined);
    assert.equal(env.LISTEN_FDS, undefined);
    assert.equal(env.LISTEN_PID, undefined);
  }
});
