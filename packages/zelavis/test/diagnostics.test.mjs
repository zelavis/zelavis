import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { findDuplicates, readProcessListing, redactCommand } from "../dist/diagnostics.js";
import { createNodeDiagnosticsControl } from "../dist/adapters/_node-diagnostics.js";

const NOW = new Date("2026-10-18T10:00:00Z");
const line = (pid, ppid, started, args) => `${String(pid).padStart(7)} ${String(ppid).padStart(7)} zelavis ${started}    01:02:03 ${args}`;

test("secrets never leave in a command line: flags, variables and URL credentials", () => {
  assert.equal(redactCommand("mariadbd --password=hunter2 --port=3306"), "mariadbd --password=[redacted] --port=3306");
  assert.equal(redactCommand("tool --api-key abc123 --name x"), "tool --api-key [redacted] --name x");
  assert.equal(redactCommand("env DB_PASSWORD=hunter2 SESSION_TOKEN=zz php"), "env DB_PASSWORD=[redacted] SESSION_TOKEN=[redacted] php");
  assert.equal(redactCommand("curl https://admin:s3cret@example.com/x"), "curl https://admin:[redacted]@example.com/x");
  assert.equal(redactCommand("caddy run --config /var/lib/zelavis/projects/a/Caddyfile"), "caddy run --config /var/lib/zelavis/projects/a/Caddyfile", "ordinary arguments are untouched");
});

test("a listing keeps Zelavis's processes, names the Project, and flags a command running twice", () => {
  const caddy = "/var/lib/zelavis/runtimes/abc/caddy run --config /var/lib/zelavis/projects/locus/.zelavis/server/Caddyfile";
  const listing = [
    line(100, 1, "Thu Oct 15 12:41:43 2026", "php-fpm: master process (/var/lib/zelavis/projects/locus/.zelavis/server/php-fpm.conf)"),
    line(101, 100, "Thu Oct 15 12:41:44 2026", "php-fpm: master process (/var/lib/zelavis/projects/locus/.zelavis/server/php-fpm.conf)"),
    line(200, 1, "Thu Oct 15 12:41:44 2026", caddy),
    line(201, 1, "Sat Oct 17 01:27:52 2026", caddy),
    line(202, 1, "Sat Oct 17 01:33:22 2026", caddy),
    line(300, 1, "Sat Oct 17 01:33:22 2026", "/usr/bin/vim notes.txt"),
    "garbage that is not a process line",
  ].join("\n");
  const report = readProcessListing(listing, { dataDirectory: "/var/lib/zelavis", user: "zelavis", now: NOW });
  assert.deepEqual(report.processes.map((entry) => entry.pid), [100, 101, 200, 201, 202], "only Zelavis's, unparseable lines skipped");
  assert.ok(report.processes.every((entry) => entry.projectId === "locus"));
  assert.deepEqual(report.duplicates.map((copy) => copy.pids), [[200, 201, 202]], "three caddies are copies; a pool worker under its master is not");
  assert.equal(report.generatedAt, NOW.toISOString());
});

test("a worker pool under one master is not a duplicate", () => {
  const entries = [1, 2, 3].map((pid) => ({ pid, parentPid: pid === 1 ? 0 : 1, user: "u", startedAt: "", elapsed: "", command: "php-fpm: pool www" }));
  assert.deepEqual(findDuplicates(entries), []);
});

test("real copies of one command are found by the real listing", async (t) => {
  const marker = `zelavis-copy-${process.pid}-${Date.now()}`;
  const copies = [0, 1].map(() => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" }));
  t.after(() => copies.forEach((child) => child.kill("SIGKILL")));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const report = await createNodeDiagnosticsControl({ dataDirectory: "/nonexistent-data" }).processes();
  const ours = report.duplicates.find((copy) => copy.command.includes(marker));
  assert.ok(ours, "the two identical processes are reported as copies");
  assert.deepEqual([...ours.pids].sort(), copies.map((child) => child.pid).sort());
});

test("debug is a permission of its own: HTTP and the SDK need server.debug.read in system scope", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-debug-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false, terminal: false }) });
  t.after(() => zv.close());
  const call = (principal) => zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/debug/processes"), { principal });
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const logsOnly = { id: "key", type: "service", permissions: ["server.logs.read", "server.terminal.use"] };
  const debugKey = { id: "key2", type: "service", permissions: ["server.debug.read"] };
  assert.equal((await call(logsOnly)).status, 403, "log and terminal access do not grant it");
  assert.equal((await call(debugKey)).status, 200);
  const report = await (await call(owner)).json();
  assert.equal(typeof report.generatedAt, "string");
  assert.ok(Array.isArray(report.processes) && Array.isArray(report.duplicates));
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: debugKey }) });
  assert.equal((await client.debug.processes()).user, report.user);
});

test("an API key made with the debug permissions reads diagnostics over HTTP, the SDK and the CLI, and nothing else", async () => {
  const { createMemorySystemStore, zelavis } = await import("../dist/index.js");
  const { runCli } = await import("../dist/cli/commands.js");
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(), bootstrap: { token: "diagnostics-bootstrap-token-0123456789abcdef" },
    diagnostics: { processes: async () => ({ generatedAt: NOW.toISOString(), user: "zelavis", processes: [], duplicates: [{ command: "caddy run", projectId: "locus", pids: [1, 2] }], truncated: false }) },
  });
  const through = (url, init) => runtime.fetch(new Request(url, init));
  const anonymous = createZelavisClient({ baseUrl: "http://localhost", fetch: through });
  await anonymous.json("/auth/bootstrap", { method: "POST", body: {
    bootstrapToken: "diagnostics-bootstrap-token-0123456789abcdef", provider: "password", account: { email: "owner@example.com" },
    credential: { identifier: "owner@example.com", password: "correct horse battery staple" } } });
  const signedIn = await anonymous.auth.signInWithPassword({ identifier: "owner@example.com", password: "correct horse battery staple" });
  const owner = createZelavisClient({ baseUrl: "http://localhost", fetch: through, headers: { authorization: `Bearer ${signedIn.session.token}` } });
  const keyWith = async (name, permissions) => (await owner.json("/auth/service-accounts", { method: "POST", body: { name, permissions, expiresInDays: 30 } })).token;
  const debugToken = await keyWith("debug", ["server.debug.read", "server.logs.read"]);
  const logsToken = await keyWith("logs only", ["server.logs.read"]);
  const as = (token) => createZelavisClient({ baseUrl: "http://localhost", fetch: through, headers: { authorization: `Bearer ${token}` } });

  assert.equal((await as(debugToken).debug.processes()).duplicates[0].projectId, "locus");
  await assert.rejects(as(logsToken).debug.processes(), { status: 403 });
  await assert.rejects(as(debugToken).terminal.status(), { status: 403 });

  const originalFetch = globalThis.fetch, originalLog = console.log;
  const printed = [];
  globalThis.fetch = through;
  console.log = (value) => printed.push(value);
  try {
    await runCli(["debug", "processes", "--url", "http://localhost/zelavis", "--token", debugToken, "--json"]);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.equal(JSON.parse(printed.join("\n")).duplicates[0].pids.length, 2);
});
