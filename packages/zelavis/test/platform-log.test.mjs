import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlatformLog, platformLogPlugin, readPlatformLogQuery } from "../dist/core/runtime/platform-log.js";
import { createServerLifecycle } from "../dist/core/runtime/lifecycle.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { Zelavis } from "../dist/index.js";

test("the log keeps only the newest entries, in order, and says when a reader fell behind", () => {
  const log = createPlatformLog(3);
  for (let n = 1; n <= 5; n += 1) log.record({ level: "info", source: "t", message: `m${n}` });
  const all = log.read();
  assert.deepEqual(all.entries.map((entry) => entry.message), ["m3", "m4", "m5"]);
  assert.equal(all.latest, 5);
  assert.equal(log.read({ after: 4 }).entries[0].message, "m5");
  assert.equal(log.read({ after: 1 }).truncated, true, "entries 2 was dropped");
  assert.equal(log.read({ after: 2 }).truncated, false);
  assert.equal(log.read({ limit: 1 }).entries[0].message, "m5", "the first page is the newest entries");
  assert.throws(() => createPlatformLog(0), RangeError);
});

test("secrets are redacted when written and sizes are bounded", () => {
  const log = createPlatformLog();
  log.record({ level: "error", source: "http", message: "failed with Authorization: Bearer abcdefghijklmnop", detail: `${"x".repeat(20_000)} DB_PASSWORD=hunter2` });
  const [entry] = log.read().entries;
  assert.ok(!entry.message.includes("abcdefghijklmnop"));
  assert.ok(entry.detail.length <= 8001);
  const second = createPlatformLog();
  second.record({ level: "error", source: "x", message: "m", detail: "DB_PASSWORD=hunter2 and more" });
  assert.ok(!second.read().entries[0].detail.includes("hunter2"));
});

test("filters by level, reference and source", () => {
  const log = createPlatformLog();
  log.record({ level: "info", source: "a", message: "i" });
  log.record({ level: "error", source: "b", message: "e", correlationId: "abc123" });
  assert.deepEqual(log.read({ level: "warn" }).entries.map((entry) => entry.message), ["e"]);
  assert.deepEqual(log.read({ correlationId: "abc123" }).entries.map((entry) => entry.message), ["e"]);
  assert.deepEqual(log.read({ source: "a" }).entries.map((entry) => entry.message), ["i"]);
});

test("query parameters are validated the same way for every transport", () => {
  assert.deepEqual(readPlatformLogQuery(new URLSearchParams("after=4&limit=10&level=warn&correlationId=8ad2ea39082e4cf6")), { after: 4, limit: 10, level: "warn", correlationId: "8ad2ea39082e4cf6" });
  for (const bad of ["after=-1", "limit=x", "level=loud", "correlationId=../etc", `source=${"s".repeat(200)}`]) {
    assert.equal(typeof readPlatformLogQuery(new URLSearchParams(bad)), "string", bad);
  }
});

test("an unexpected request failure is recorded with the reference the client received", async () => {
  const log = createPlatformLog();
  const lifecycle = createServerLifecycle();
  platformLogPlugin(log)({ hooks: lifecycle });
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  try {
    await lifecycle.emit("error", { error: new TypeError("secret path /srv/x broke"), request: new Request("http://localhost/zelavis/api/v1/runtime/projects?token=zvs_abcdefghijkl", { method: "POST" }), correlationId: "8ad2ea39082e4cf6" });
  } finally {
    console.error = original;
  }
  const [entry] = log.read({ correlationId: "8ad2ea39082e4cf6" }).entries;
  assert.equal(entry.level, "error");
  assert.match(entry.message, /POST \/zelavis\/api\/v1\/runtime\/projects failed: TypeError: secret path \/srv\/x broke/);
  assert.ok(!entry.message.includes("token"), "the query is never logged");
  assert.match(entry.detail, /TypeError/);
  assert.match(lines[0], /8ad2ea39082e4cf6/, "the journal keeps the same reference");
});

test("the log is read over HTTP and the SDK, and needs its own permission", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-logs-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data, services: false, projects: false }) });
  t.after(() => zv.close());
  const call = (query, principal) => zv.fetch(new Request(`http://localhost/zelavis/api/v1/runtime/logs${query}`), { principal });
  const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
  const nobody = { id: "n", type: "user", permissions: [] };
  assert.equal((await call("", nobody)).status, 403);
  assert.equal((await call("?level=loud", owner)).status, 400);
  const page = await (await call("", owner)).json();
  assert.ok(Array.isArray(page.entries) && typeof page.latest === "number");
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: (input, init) => zv.fetch(new Request(input, init), { principal: owner }) });
  assert.deepEqual((await client.logs.read({ limit: 5 })).entries.length <= 5, true);
});
