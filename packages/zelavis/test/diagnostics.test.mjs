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

test("Project diagnostics include hosts whose root ends the command and their private engine workers", () => {
  const listing = [
    line(10, 1, "Mon Oct 19 10:35:04 2026", "/opt/zelavis/bin/zelavis"),
    line(11, 10, "Mon Oct 19 10:35:05 2026", "/opt/zelavis/node _node-runtime-worker.js --workload platform"),
    line(20, 1, "Mon Oct 19 10:35:51 2026", "/opt/zelavis/node _node-project-runner.js --project-root /var/lib/zelavis/projects/nexus"),
    line(21, 20, "Mon Oct 19 10:35:59 2026", "/opt/zelavis/node _node-runtime-worker.js --workload nexus"),
    line(30, 1, "Mon Oct 19 10:35:51 2026", "/opt/zelavis/node _node-project-runner.js --integration --project-root /var/lib/zelavis/projects/blogger"),
    line(31, 30, "Mon Oct 19 10:35:59 2026", "/opt/zelavis/node _node-runtime-worker.js --workload blogger"),
  ].join('\n');
  const report = readProcessListing(listing, { dataDirectory: "/var/lib/zelavis", user: "zelavis", now: NOW });
  assert.deepEqual(report.processes.map(entry => [entry.pid, entry.projectId]),
    [[10, undefined], [11, undefined], [20, 'nexus'], [21, 'nexus'], [30, 'blogger'], [31, 'blogger']]);
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

test("visible workload labels distinguish real engine workers but still expose a duplicate of one workload", async (t) => {
  const marker = `zelavis-engine-${process.pid}-${Date.now()}`;
  const workers = ["alpha", "beta", "alpha"].map(workload => spawn(process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker, "--workload", workload], { stdio: "ignore" }));
  t.after(() => workers.forEach(child => child.kill("SIGKILL")));
  await new Promise(resolve => setTimeout(resolve, 300));
  const report = await createNodeDiagnosticsControl({ dataDirectory: "/nonexistent-data" }).processes();
  const duplicates = report.duplicates.filter(copy => copy.command.includes(marker));
  assert.equal(duplicates.length, 1);
  assert.deepEqual([...duplicates[0].pids].sort(), [workers[0].pid, workers[2].pid].sort());
  assert.ok(!duplicates[0].pids.includes(workers[1].pid), "another workload is not a stale copy");
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

test("one Project's diagnostics gather its record, runtime log, Platform log entries and processes, and need server.debug.read", async (t) => {
  const { createMemorySystemStore, zelavis } = await import("../dist/index.js");
  const digest = `sha256:${"a".repeat(64)}`;
  const recipe = { name: "@zelavis/app", title: "Zelavis App", version: "1.0.0", specifier: "@zelavis/app", runtimeKinds: ["native"], artifact: { digest } };
  const running = new Set();
  const runtime = {
    name: "fixture", runtimeKinds: ["native"],
    capabilities: () => ({ zeroDowntimeUpdates: false, independentRuntimeVersion: false }), supportsLiveUpdate: () => false,
    async prepare() {},
    async start(project) { running.add(project.id); return { status: "running", url: "http://127.0.0.1:1" }; },
    async stop(id) { running.delete(id); return { status: "stopped" }; },
    async status(id) { return { status: running.has(id) ? "running" : "stopped", ...(running.has(id) ? { url: "http://127.0.0.1:1" } : {}) }; },
    async logs() { return Array.from({ length: 150 }, (_, index) => ({ at: NOW.toISOString(), stream: "stdout", line: `line ${index}` })); },
    async destroy(id) { running.delete(id); }, async close() {},
  };
  const copies = { generatedAt: NOW.toISOString(), user: "zelavis", truncated: false,
    processes: [
      { pid: 7, parentPid: 1, user: "zelavis", startedAt: "", elapsed: "", projectId: "alpha", command: "caddy run" },
      { pid: 8, parentPid: 1, user: "zelavis", startedAt: "", elapsed: "", projectId: "other", command: "caddy run" }],
    duplicates: [{ command: "caddy run", projectId: "alpha", pids: [7, 9] }, { command: "caddy run", projectId: "other", pids: [8, 10] }] };
  const zv = await zelavis({
    systemStore: createMemorySystemStore(), projectRuntime: runtime,
    serviceRegistry: { catalog: [{ service: { ...recipe, kind: "app", project: { runtimeKinds: ["native"] } }, specifier: "@zelavis/app", source: "official", status: "available" }] },
    diagnostics: { processes: async () => copies },
  });
  t.after(() => zv.close());
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const debugKey = { id: "key", type: "service", permissions: ["server.debug.read"] };
  const as = (principal) => createZelavisClient({ baseUrl: "http://localhost", fetch: (url, init) => zv.fetch(new Request(url, init), { principal }) });
  await as(owner).projects.create({ id: "alpha", name: "Alpha" });

  const snapshot = await as(debugKey).debug.project("alpha");
  assert.equal(snapshot.project.id, "alpha");
  assert.equal(snapshot.logs.length, 100, "the runtime log is bounded to its newest lines");
  assert.equal(snapshot.logs.at(-1).line, "line 149");
  assert.deepEqual(snapshot.processes.map((entry) => entry.pid), [7], "only this Project's processes");
  assert.deepEqual(snapshot.duplicates.map((copy) => copy.pids), [[7, 9]]);
  assert.ok(snapshot.platformLog.every((entry) => entry.message.includes("alpha")));
  await assert.rejects(as(debugKey).debug.project("missing"), { status: 404 });
  await assert.rejects(as({ id: "k", type: "service", permissions: ["server.logs.read", "project.view"] }).debug.project("alpha"), { status: 403 });
});

test("the update history is readable with the debug permission over HTTP, the SDK and the CLI", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { runCli } = await import("../dist/cli/commands.js");
  const data = await mkdtemp(join(tmpdir(), "zelavis-debug-updates-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, "update"), { recursive: true });
  const run = { id: "r1", state: "rolled-back", from: "2.0.0-alpha.36", to: "2.0.0-alpha.38", startedAt: "2026-10-18T09:00:00.000Z", finishedAt: "2026-10-18T09:03:00.000Z",
    message: "The installer stopped with an error (exit 1). Rolled back.", log: ["Project locus was not adopted at its stable address: stopped."] };
  await writeFile(join(data, "update", "history.json"), JSON.stringify([run, { not: "a run" }]));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false, terminal: false }) });
  t.after(() => zv.close());
  const debugKey = { id: "key", type: "service", permissions: ["server.debug.read"] };
  const through = (principal) => (input, init) => zv.fetch(new Request(input, init), { principal });
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through(debugKey) });
  const { status, history } = await client.debug.updates();
  assert.deepEqual(history.map((entry) => [entry.id, entry.state]), [["r1", "rolled-back"]], "damaged entries are skipped");
  assert.match(history[0].log[0], /locus was not adopted/);
  assert.equal(typeof status.current, "string");
  await assert.rejects(createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through({ id: "k", type: "service", permissions: ["system.updates.view"] }) }).debug.updates(), { status: 403 });

  const originalFetch = globalThis.fetch, originalLog = console.log;
  const printed = [];
  globalThis.fetch = (input, init) => zv.fetch(new Request(input, init), { principal: debugKey });
  console.log = (value) => printed.push(value);
  try { await runCli(["debug", "updates", "--url", "http://localhost/zelavis", "--token", "ignored"]); }
  finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.match(printed.join("\n"), /rolled-back.*2\.0\.0-alpha\.36 -> 2\.0\.0-alpha\.38/);
  assert.match(printed.join("\n"), /Project locus was not adopted/);
});
