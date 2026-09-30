import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_AUDIT_RETENTION_MS,
  Zelavis,
  createAssistantAuditReader,
  createAssistantToolAudit,
  createMemorySystemStore,
} from "../dist/index.js";

async function seed(store, count, { start = Date.parse("2026-01-01T00:00:00Z"), principals = ["a", "b"] } = {}) {
  const write = createAssistantToolAudit(store);
  for (let i = 0; i < count; i += 1) {
    await write({
      id: `id${i}`, at: new Date(start + i * 1000).toISOString(),
      principalId: principals[i % principals.length], tool: i % 3 === 0 ? "get_project" : "stop_project",
      arguments: "{}", decision: i % 2 ? "denied" : "allowed",
    });
  }
}

test("records come back newest first, in pages, with filters", async () => {
  const store = createMemorySystemStore();
  await seed(store, 25);
  const reader = createAssistantAuditReader(store);

  const first = await reader.list({ limit: 10 });
  assert.equal(first.records.length, 10);
  assert.equal(first.records[0].id, "id24");
  assert.ok(first.next);
  const second = await reader.list({ limit: 10, before: first.next });
  assert.equal(second.records[0].id, "id14");
  const third = await reader.list({ limit: 10, before: second.next });
  assert.equal(third.records.length, 5);
  assert.equal(third.next, undefined);
  const seen = new Set([...first.records, ...second.records, ...third.records].map((r) => r.id));
  assert.equal(seen.size, 25, "pages neither overlap nor skip");

  const onlyA = await reader.list({ principalId: "a", limit: 100 });
  assert.ok(onlyA.records.every((r) => r.principalId === "a"));
  const denied = await reader.list({ decision: "denied", tool: "stop_project", limit: 100 });
  assert.ok(denied.records.every((r) => r.decision === "denied" && r.tool === "stop_project"));
  assert.ok(denied.records.length > 0);
});

test("bad queries are refused", async () => {
  const reader = createAssistantAuditReader(createMemorySystemStore());
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Number.NaN }, { decision: "maybe" }]) {
    await assert.rejects(reader.list(query), { name: "AssistantAuditQueryError" }, JSON.stringify(query));
  }
});

test("records past the retention window are pruned, a batch at a time", async () => {
  const store = createMemorySystemStore();
  const now = Date.parse("2026-06-01T00:00:00Z");
  await seed(store, 10, { start: now - ASSISTANT_AUDIT_RETENTION_MS - 60 * 60_000 });
  await seed(store, 3, { start: now - 1000 });
  const reader = createAssistantAuditReader(store);
  assert.equal(await reader.prune({ now, batch: 4 }), 4);
  assert.equal(await reader.prune({ now }), 6);
  assert.equal(await reader.prune({ now }), 0);
  assert.equal((await reader.list({ limit: 100 })).records.length, 3);
});

test("over HTTP only an audit reader can read it, and nothing secret is in it", async () => {
  let step = 0;
  const model = { name: "m", generate: async () => step++ === 0
    ? { content: "", toolCalls: [{ id: "c", name: "get_project", arguments: "Authorization: Bearer abcdef1234567890 sk-or-v1-abcdefghijklmnop1234" }] }
    : { content: "done", toolCalls: [] } };
  const zv = new Zelavis({ assistant: { model } });
  const chatter = { id: "chatter", type: "user", permissions: ["assistant.use"] };
  const auditor = { id: "auditor", type: "user", permissions: ["server.assistant.audit"] };
  const call = (principal, path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, init), { principal });
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const thread = (await (await call(chatter, "/threads", post({}))).json()).thread;
  await call(chatter, `/threads/${thread.id}/messages`, post({ content: "look" }));

  assert.equal((await call(chatter, "/audit")).status, 403, "chatting is not auditing");
  const response = await call(auditor, "/audit?limit=10");
  assert.equal(response.status, 200);
  const text = await response.clone().text();
  assert.ok(!text.includes("abcdef1234567890") && !text.includes("abcdefghijklmnop1234"), text);
  const body = await response.json();
  assert.equal(body.records[0].principalId, "chatter");
  assert.equal(body.records[0].tool, "get_project");
  assert.equal(body.records[0].decision, "invalid");
  assert.equal((await call(auditor, "/audit?limit=1000")).status, 400);
  assert.equal((await call(auditor, "/audit?decision=nope")).status, 400);
  assert.equal((await call(auditor, "/audit?principalId=nobody")).status, 200);
});
