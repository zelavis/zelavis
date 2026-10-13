import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { createNodeTerminalControl } from "../dist/adapters/_node-terminal.js";
import { checkTerminalSize, ZelavisTerminalRefusal } from "../dist/terminal.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { Zelavis } from "../dist/index.js";

/** A tmux that keeps sessions in memory and echoes typed text into the file tmux would append to. */
function fakeTmux() {
  const sessions = new Map();
  const calls = [];
  const run = (args) => Effect.promise(async () => {
    calls.push(args);
    const [command, ...rest] = args;
    const target = rest[rest.indexOf("-t") + 1];
    const fail = (stderr = "can't find session") => ({ code: 1, stdout: "", stderr });
    switch (command) {
      case "-V": return { code: 0, stdout: "tmux 3.4", stderr: "" };
      case "new-session": sessions.set(rest[rest.indexOf("-s") + 1], { pipe: undefined, screen: "$ " }); return { code: 0, stdout: "", stderr: "" };
      case "pipe-pane": {
        const session = sessions.get(target);
        if (!session) return fail();
        const command = rest.at(-1);
        session.pipe = rest.includes("-O") ? /'(.*)'$/.exec(command)[1] : undefined;
        return { code: 0, stdout: "", stderr: "" };
      }
      case "send-keys": {
        const session = sessions.get(target);
        if (!session) return fail();
        if (session.pipe) await appendFile(session.pipe, rest.at(-1));
        return { code: 0, stdout: "", stderr: "" };
      }
      case "capture-pane": return sessions.has(target) ? { code: 0, stdout: "line one\nprompt$ \n", stderr: "" } : fail();
      case "display-message": return { code: 0, stdout: "7 1\n", stderr: "" };
      case "resize-window": return sessions.has(target) ? { code: 0, stdout: "", stderr: "" } : fail();
      case "has-session": return sessions.has(target) ? { code: 0, stdout: "", stderr: "" } : fail();
      case "kill-session": return sessions.delete(target) ? { code: 0, stdout: "", stderr: "" } : fail();
      case "list-sessions": return sessions.size ? { code: 0, stdout: [...sessions.keys()].join("\n"), stderr: "" } : fail("no server running");
      default: return fail(`unknown ${command}`);
    }
  });
  return { run, sessions, calls };
}

async function setup(t, extra = {}) {
  const data = await mkdtemp(join(tmpdir(), "zelavis-terminal-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const tmux = fakeTmux();
  const control = createNodeTerminalControl({ dataDirectory: data, run: tmux.run, schedule: false, ...extra });
  t.after(() => control.stop());
  return { data, tmux, control };
}
const size = { cols: 80, rows: 24 };
const refusal = (code) => (error) => error instanceof ZelavisTerminalRefusal && error.code === code;
const text = (output) => Buffer.from(output.data, "base64").toString();

test("a session starts from the screen, then follows what is typed, in order", async (t) => {
  const { control } = await setup(t);
  const session = await control.open("alice", size);
  assert.match(session.id, /^[0-9a-f]{16}$/);
  const first = await control.read("alice", session.id);
  assert.equal(first.reset, true);
  assert.match(text(first), /line one\r\nprompt\$ \x1b\[2;8H$/, "history, then the cursor placed on the screen");
  await control.write("alice", session.id, "ls\r");
  const next = await control.read("alice", session.id, first.cursor);
  assert.deepEqual([text(next), next.reset, next.more], ["ls\r", false, false]);
  const none = await control.read("alice", session.id, next.cursor);
  assert.equal(none.data, "");
  assert.equal(none.cursor, next.cursor);
  assert.equal((await control.list("alice")).length, 1);
});

test("a session belongs to the principal that opened it", async (t) => {
  const { control } = await setup(t);
  const session = await control.open("alice", size);
  assert.deepEqual(await control.list("bob"), []);
  for (const attempt of [() => control.read("bob", session.id), () => control.write("bob", session.id, "x"), () => control.resize("bob", session.id, size), () => control.close("bob", session.id)]) {
    await assert.rejects(attempt(), refusal("not-found"), "someone else's session is indistinguishable from a missing one");
  }
  await assert.rejects(control.read("alice", "../etc/passwd"), refusal("not-found"));
  await control.close("alice", session.id);
  await assert.rejects(control.read("alice", session.id), refusal("not-found"));
});

test("input, size and sessions are bounded", async (t) => {
  const { control, data } = await setup(t);
  const session = await control.open("alice", size);
  await assert.rejects(control.write("alice", session.id, "x".repeat(16 * 1024 + 1)), refusal("invalid"));
  await assert.rejects(control.write("alice", session.id, "a\0b"), refusal("invalid"));
  await assert.rejects(control.write("alice", session.id, ""), refusal("invalid"));
  await assert.rejects(control.open("alice", { cols: 5, rows: 24 }), refusal("invalid"));
  await assert.rejects(control.resize("alice", session.id, { cols: 80, rows: 9999 }), refusal("invalid"));
  await assert.rejects(control.read("alice", session.id, "../../x"), refusal("invalid"));
  for (let n = 1; n < 4; n += 1) await control.open("alice", size);
  await assert.rejects(control.open("alice", size), refusal("limit"));
  for (let n = 0; n < 4; n += 1) await control.open("bob", size);
  await assert.rejects(control.open("carol", size), refusal("limit"), "the server-wide cap holds too");
  assert.throws(() => checkTerminalSize({ cols: 80.5, rows: 24 }), ZelavisTerminalRefusal);
  assert.ok((await readdir(join(data, "terminal"))).length > 0);
});

test("a large burst is read in bounded pieces", async (t) => {
  const { control, tmux } = await setup(t);
  const session = await control.open("alice", size);
  const first = await control.read("alice", session.id);
  const [name] = tmux.sessions.keys();
  await appendFile(tmux.sessions.get(name).pipe, "z".repeat(150 * 1024));
  const a = await control.read("alice", session.id, first.cursor);
  assert.equal(Buffer.from(a.data, "base64").length, 64 * 1024);
  assert.equal(a.more, true);
  const b = await control.read("alice", session.id, a.cursor);
  const c = await control.read("alice", session.id, b.cursor);
  assert.equal(Buffer.from(c.data, "base64").length, 150 * 1024 - 128 * 1024);
  assert.equal(c.more, false);
});

test("an output file that grows past its bound is replaced and readers are resynchronised", async (t) => {
  const { control, tmux } = await setup(t);
  const session = await control.open("alice", size);
  const first = await control.read("alice", session.id);
  const [name] = tmux.sessions.keys();
  await appendFile(tmux.sessions.get(name).pipe, "q".repeat(2 * 1024 * 1024 + 10));
  const after = await control.read("alice", session.id, first.cursor);
  assert.equal(after.reset, true, "the stream moved to a fresh file, so the screen is sent again");
  assert.match(after.cursor, /^g1\.0$/);
  await control.write("alice", session.id, "hi");
  assert.equal(text(await control.read("alice", session.id, after.cursor)), "hi");
});

test("a shell that exited is reported as ended, and an orphaned record is cleaned up", async (t) => {
  const { control, tmux } = await setup(t);
  const session = await control.open("alice", size);
  const first = await control.read("alice", session.id);
  tmux.sessions.clear();
  await assert.rejects(control.read("alice", session.id, first.cursor), refusal("not-found"));
  assert.deepEqual(await control.list("alice"), [], "the record without a session is dropped");
});

test("sessions survive a restart of the Platform", async (t) => {
  let clock = 1_000_000;
  const { data, tmux, control } = await setup(t, { now: () => clock, idleMs: 60_000 });
  const session = await control.open("alice", size);
  const restarted = createNodeTerminalControl({ dataDirectory: data, run: tmux.run, schedule: false, now: () => clock, idleMs: 60_000 });
  t.after(() => restarted.stop());
  assert.deepEqual((await restarted.list("alice")).map((entry) => entry.id), [session.id], "tmux kept it, the record found it again");
  await restarted.read("alice", session.id);
  assert.equal(tmux.sessions.size, 1);
});

test("a session nobody touches is closed", async (t) => {
  const { control, tmux } = await setup(t, { schedule: true, idleMs: 30, reapIntervalMs: 20 });
  const session = await control.open("alice", size);
  assert.equal(tmux.sessions.size, 1);
  for (let wait = 0; wait < 100 && tmux.sessions.size > 0; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tmux.sessions.size, 0, "the idle session was killed");
  await assert.rejects(control.read("alice", session.id), refusal("not-found"));
});

test("without tmux the terminal reports why, and opens nothing", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-terminal-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const missing = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
  const control = createNodeTerminalControl({ dataDirectory: data, schedule: false, run: () => Effect.fail(new (class extends Error { constructor() { super("x"); this._tag = "IntegrationFailure"; this.cause = missing; } })()) });
  const status = await control.status();
  assert.equal(status.available, false);
  assert.match(status.reason, /tmux is not installed/);
  await assert.rejects(control.open("alice", size), refusal("unavailable"));
});

test("the terminal is the owner's: HTTP and the SDK need server.terminal.use", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-terminal-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const path = process.env.PATH;
  process.env.PATH = join(data, "no-such-bin");
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false }) });
  process.env.PATH = path;
  t.after(() => zv.close());
  const call = (suffix, principal, init = {}) => zv.fetch(new Request(`http://localhost/zelavis/api/v1/runtime/terminal${suffix}`, init), { principal });
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const nobody = { id: "n", type: "user", permissions: ["system.updates.view", "server.logs.read"] };
  assert.equal((await call("", nobody)).status, 403);
  assert.equal((await call("/sessions", nobody, { method: "POST", body: JSON.stringify(size), headers: { "content-type": "application/json" } })).status, 403);
  const overview = await (await call("", owner)).json();
  assert.equal(overview.available, false);
  assert.deepEqual(overview.sessions, []);
  const opened = await call("/sessions", owner, { method: "POST", body: JSON.stringify(size), headers: { "content-type": "application/json" } });
  assert.equal(opened.status, 503);
  assert.equal((await opened.json()).code, "unavailable");
  assert.equal((await call("/sessions/not-an-id/output", owner)).status, 404);
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: owner }) });
  assert.deepEqual(await client.terminal.status(), overview);
  await assert.rejects(client.terminal.open(size), { status: 503 });
});

test("sessions work end to end over HTTP and the SDK, scoped to the principal, with opening and closing logged", async (t) => {
  const { control } = await setup(t);
  const data = await mkdtemp(join(tmpdir(), "zelavis-terminal-http-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false, terminal: control }) });
  t.after(() => zv.close());
  const principal = (id) => ({ id, type: "user", roles: ["owner"], permissions: ["*"] });
  const clientFor = (id) => createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: principal(id) }) });
  const alice = clientFor("alice");
  const bob = clientFor("bob");

  const session = await alice.terminal.open(size);
  assert.deepEqual((await alice.terminal.status()).sessions.map((entry) => entry.id), [session.id]);
  assert.deepEqual((await bob.terminal.status()).sessions, []);
  const first = await alice.terminal.read(session.id);
  assert.equal(first.reset, true);
  await alice.terminal.write(session.id, "pwd\r");
  assert.equal(text(await alice.terminal.read(session.id, first.cursor)), "pwd\r");
  await alice.terminal.resize(session.id, { cols: 120, rows: 40 });
  await assert.rejects(bob.terminal.read(session.id), { status: 404 });
  await assert.rejects(alice.terminal.open({ cols: 3, rows: 3 }), { status: 400 });
  await alice.terminal.close(session.id);
  await assert.rejects(alice.terminal.read(session.id), { status: 404 });

  const log = await (await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/logs"), { principal: principal("alice") })).json();
  const lines = log.entries.filter((entry) => entry.source === "terminal").map((entry) => entry.message);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /opened \(principal alice, session /);
  assert.match(lines[1], /closed \(principal alice/);
  assert.ok(!JSON.stringify(log).includes("pwd"), "what is typed is never logged");
});

test("installing tmux goes through the host package operation with the fixed set, as the caller", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-terminal-install-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const submitted = [];
  const broker = {
    submit: async (request, principal) => { submitted.push({ request, principal: principal?.id }); return { operationId: "op1", agent: { status: "succeeded" } }; },
    get: async () => ({ operationId: "op1", agent: { status: "succeeded" } }),
  };
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false }), hostOperations: broker });
  t.after(() => zv.close());
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const nobody = { id: "n", type: "user", permissions: [] };
  const install = (principal) => zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/terminal/install", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), { principal });
  assert.equal((await install(nobody)).status, 403);
  assert.equal(submitted.length, 0, "no authority, no operation");
  assert.equal((await install(owner)).status, 200);
  assert.deepEqual(submitted[0].request.arguments, { set: "terminal" });
  assert.equal(submitted[0].request.operation, "zelavis.packages-install");
  assert.equal(submitted[0].principal, "owner");
});
