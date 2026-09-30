import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_MAX_MESSAGES_PER_THREAD,
  ASSISTANT_MAX_PROMPT_CHARS,
  ASSISTANT_MAX_THREADS_PER_OWNER,
  Zelavis,
  createAssistantManager,
  createAssistantTurnLimiter,
  createMemorySystemStore,
  createModelAssistantResponder,
} from "../dist/index.js";

const user = { id: "u", type: "user", permissions: ["assistant.use"] };

test("a caller gets a bounded number of turns per window, and only some at once", () => {
  let clock = 0;
  const limiter = createAssistantTurnLimiter({ turnsPerWindow: 3, windowMs: 1000, maxConcurrent: 2, now: () => clock });
  const first = limiter.acquire("a");
  const second = limiter.acquire("a");
  assert.ok("permit" in first && "permit" in second);
  assert.ok("retryAfterSeconds" in limiter.acquire("a"), "a third at once waits");
  first.permit.release();
  first.permit.release(); // releasing twice frees only one slot
  const third = limiter.acquire("a");
  assert.ok("permit" in third, "one slot came back");
  assert.ok("retryAfterSeconds" in limiter.acquire("a"), "and only one");
  second.permit.release();
  third.permit.release();
  const window = limiter.acquire("a");
  assert.ok("retryAfterSeconds" in window, "the window budget of three is spent");
  assert.ok(window.retryAfterSeconds >= 1);
  assert.ok("permit" in limiter.acquire("b"), "another caller is unaffected");
  clock = 1500;
  assert.ok("permit" in limiter.acquire("a"), "the window slides");
});

test("prompts, threads and chats are bounded", async () => {
  const manager = createAssistantManager({ store: createMemorySystemStore() });
  const thread = await manager.create("u");
  await assert.rejects(
    manager.appendMessage(thread.id, "x".repeat(ASSISTANT_MAX_PROMPT_CHARS + 1), user),
    { name: "ZelavisAssistantValidationError" },
  );
  await manager.appendMessage(thread.id, "x".repeat(ASSISTANT_MAX_PROMPT_CHARS), user);

  for (let i = 1; i < ASSISTANT_MAX_THREADS_PER_OWNER; i += 1) await manager.create("u");
  await assert.rejects(manager.create("u"), /already have/);
  assert.ok(await manager.create("someone-else"), "the cap is per owner");
  assert.equal(typeof ASSISTANT_MAX_MESSAGES_PER_THREAD, "number");
});

test("a turn never sends more history to the provider than its budget", async () => {
  const sent = [];
  const model = { name: "m", generate: async (input) => { sent.push(input.messages); return { content: "ok", toolCalls: [] }; } };
  const responder = createModelAssistantResponder({ model });
  const big = "y".repeat(8000);
  const messages = Array.from({ length: 24 }, (_, i) => ({
    id: String(i), role: i % 2 ? "assistant" : "user", content: big, createdAt: "",
  }));
  messages.push({ id: "last", role: "user", content: "what now", createdAt: "" });
  await responder.respond({
    thread: { id: "t", ownerId: "u", title: "", messages, createdAt: "", updatedAt: "" },
    prompt: "what now", principal: user,
  });
  const total = sent[0].reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total < 49_000 + 500, `sent ${total} characters`);
  assert.equal(sent[0].at(-1).content, "what now", "the message being answered is always included");
});

test("over HTTP a caller cannot run more than two turns at once, and is told when to retry", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const model = { name: "m", generate: async () => { await gate; return { content: "done", toolCalls: [] }; } };
  const zv = new Zelavis({ assistant: { model } });
  const call = (path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, init), { principal: user });
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const threads = [];
  for (let i = 0; i < 3; i += 1) threads.push((await (await call("/threads", post({}))).json()).thread.id);

  const running = threads.slice(0, 2).map((id) => call(`/threads/${id}/messages`, post({ content: "hi" })));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const refused = await call(`/threads/${threads[2]}/messages`, post({ content: "hi" }));
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  const streamRefused = await call(`/threads/${threads[2]}/messages/stream`, post({ content: "hi" }));
  assert.equal(streamRefused.status, 429);

  release();
  assert.deepEqual((await Promise.all(running)).map((r) => r.status), [201, 201]);
  const after = await call(`/threads/${threads[2]}/messages`, post({ content: "hi" }));
  assert.equal(after.status, 201, "capacity comes back when turns finish");
});

test("an owner can delete a thread and its requests, and nobody else can", async () => {
  const zv = new Zelavis({ assistant: { model: { name: "m", generate: async () => ({ content: "ok", toolCalls: [] }) } } });
  const other = { id: "other", type: "user", permissions: ["assistant.use"] };
  const call = (principal, path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, init), { principal });
  const created = (await (await call(user, "/threads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).thread;
  assert.equal((await call(other, `/threads/${created.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await call(user, `/threads/${created.id}`)).status, 200);
  assert.equal((await call(user, `/threads/${created.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(user, `/threads/${created.id}`)).status, 404);
  assert.equal((await call(user, `/threads/${created.id}`, { method: "DELETE" })).status, 404);
});
