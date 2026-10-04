import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { nodeAdapter } from "../dist/adapters/node.js";
import {
  Zelavis,
  createAnthropicModel,
  createAssistantProviderConfig,
  createConfiguredAssistantResponder,
  createMemorySystemStore,
  createOpenAIModel,
  createOpenRouterModel,
} from "../dist/index.js";

const KEY = "sk-or-very-secret-key";
const SECRET = "m".repeat(64);
const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
const chatter = { id: "chat", type: "user", permissions: ["assistant.use"] };

function fakeFetch(reply = "from the model") {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const threadOf = (projectId) => ({
  id: "t", ownerId: "owner", title: "", ...(projectId ? { projectId } : {}),
  messages: [], createdAt: "", updatedAt: "",
});

test("the stored key is encrypted, never returned, and resolved per request", async () => {
  const store = createMemorySystemStore();
  const fetcher = fakeFetch();
  const provider = createAssistantProviderConfig({ store, masterSecret: SECRET, env: {}, fetch: fetcher });
  const responder = createConfiguredAssistantResponder({ provider });

  assert.equal((await provider.status({})).mode, "local-router");
  const before = await responder.respond({ thread: threadOf(), prompt: "hello", principal: owner });
  assert.match(before.content, /navigate/i, "no key: the local router answers");
  assert.equal(before.provider, "local-router");
  assert.equal(fetcher.calls.length, 0);

  const status = await provider.set({}, { provider: "openrouter", model: "vendor/model", apiKey: KEY }, "owner");
  assert.deepEqual(
    { mode: status.mode, provider: status.provider, model: status.model, hasApiKey: status.hasApiKey, source: status.source },
    { mode: "model", provider: "openrouter", model: "vendor/model", hasApiKey: true, source: "stored" },
  );
  assert.ok(!JSON.stringify(status).includes(KEY));
  assert.ok(!JSON.stringify(await store.get("assistant-provider", "config")).includes(KEY),
    "the key is not stored in the clear");

  const after = await responder.respond({ thread: threadOf(), prompt: "hello", principal: owner });
  assert.equal(after.content, "from the model");
  assert.equal(after.provider, "openrouter:vendor/model", "the reply records which provider wrote it");
  assert.equal(fetcher.calls[0].init.headers.authorization, `Bearer ${KEY}`);

  await provider.clear({});
  const cleared = await responder.respond({ thread: threadOf(), prompt: "hello", principal: owner });
  assert.match(cleared.content, /navigate/i);
});

test("the environment wins for the installation and cannot be changed through the API", async () => {
  const provider = createAssistantProviderConfig({
    store: createMemorySystemStore(), masterSecret: SECRET, fetch: fakeFetch(),
    env: { ZELAVIS_ASSISTANT_PROVIDER: "openai", ZELAVIS_ASSISTANT_API_KEY: KEY, ZELAVIS_ASSISTANT_MODEL: "gpt-x" },
  });
  const status = await provider.status({});
  assert.equal(status.source, "environment");
  assert.equal(status.provider, "openai");
  assert.equal(status.model, "gpt-x");
  await assert.rejects(provider.set({}, { model: "a/b", apiKey: "another-long-key" }, "o"), { status: 409 });
  await assert.rejects(provider.clear({}), { status: 409 });
  // A Project bringing its own key is separate and still allowed.
  const own = await provider.set({ projectId: "site" }, { provider: "anthropic", model: "claude-x", apiKey: "project-key-123" }, "o");
  assert.equal(own.source, "project");
});

test("provider settings are validated", async () => {
  const provider = createAssistantProviderConfig({ store: createMemorySystemStore(), masterSecret: SECRET, env: {} });
  for (const input of [
    {}, { model: "vendor/model" }, { apiKey: KEY },
    { model: "bad model!", apiKey: KEY }, { model: "a/b", apiKey: "short" },
    { model: "a/b", apiKey: "has space in it" }, { provider: "other", model: "a/b", apiKey: KEY },
  ]) {
    await assert.rejects(provider.set({}, input, "o"), { status: 400 }, JSON.stringify(input));
  }
});

test("a Project's own key answers only that Project's chats", async () => {
  const store = createMemorySystemStore();
  const fetcher = fakeFetch("answer");
  const provider = createAssistantProviderConfig({ store, masterSecret: SECRET, env: {}, fetch: fetcher });
  const responder = createConfiguredAssistantResponder({ provider });
  await provider.set({}, { model: "platform/model", apiKey: "platform-key-123" }, "o");
  await provider.set({ projectId: "site-a" }, { provider: "openai", model: "gpt-a", apiKey: "site-a-key-123" }, "o");

  const used = async (projectId) => {
    fetcher.calls.length = 0;
    const reply = await responder.respond({ thread: threadOf(projectId), prompt: "x", principal: owner });
    return { url: fetcher.calls[0].url, auth: fetcher.calls[0].init.headers.authorization, provider: reply.provider };
  };
  assert.deepEqual(await used("site-a"), {
    url: "https://api.openai.com/v1/chat/completions", auth: "Bearer site-a-key-123", provider: "openai:gpt-a",
  });
  for (const projectId of ["site-b", undefined]) {
    assert.deepEqual(await used(projectId), {
      url: "https://openrouter.ai/api/v1/chat/completions", auth: "Bearer platform-key-123", provider: "openrouter:platform/model",
    }, String(projectId));
  }

  await provider.clear({ projectId: "site-a" });
  assert.equal((await used("site-a")).auth, "Bearer platform-key-123");
});

test("what a Project is shown never reveals the installation's provider", async () => {
  const provider = createAssistantProviderConfig({ store: createMemorySystemStore(), masterSecret: SECRET, env: {} });
  assert.deepEqual(await provider.status({ projectId: "site" }), { mode: "local-router", hasApiKey: false, source: "none" });
  await provider.set({}, { model: "platform/secret-model", apiKey: "platform-key-123" }, "o");
  const inherited = await provider.status({ projectId: "site" });
  assert.deepEqual(inherited, { mode: "model", hasApiKey: false, source: "platform" });
  assert.ok(!JSON.stringify(inherited).includes("secret-model"));
});

test("a stored key is bound to its Project and does not decrypt anywhere else", async () => {
  const store = createMemorySystemStore();
  const provider = createAssistantProviderConfig({ store, masterSecret: SECRET, env: {}, fetch: fakeFetch() });
  await provider.set({ projectId: "site-a" }, { model: "a/b", apiKey: "site-a-key-123" }, "o");
  const record = await store.get("assistant-provider", "project:site-a");
  // The same ciphertext copied onto another Project, or onto the installation.
  await store.set("assistant-provider", "project:site-b", record.value);
  await store.set("assistant-provider", "config", record.value);
  await assert.rejects(provider.resolveModel("site-b"));
  await assert.rejects(provider.resolveModel(undefined));
  assert.ok(await provider.resolveModel("site-a"));
});

test("a deleted Project's key is removed", async () => {
  const store = createMemorySystemStore();
  const provider = createAssistantProviderConfig({ store, masterSecret: SECRET, env: {} });
  await provider.set({ projectId: "gone" }, { model: "a/b", apiKey: "gone-key-1234" }, "o");
  await provider.removeProject("gone");
  assert.equal(await store.get("assistant-provider", "project:gone"), undefined);
});

test("only a settings manager can change the installation's provider over HTTP", async () => {
  const zv = new Zelavis();
  const call = (principal, method, body) => zv.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/assistant/provider", {
      method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { principal });

  assert.equal((await call(chatter, "GET")).status, 403);
  assert.equal((await call(chatter, "PUT", { model: "a/b", apiKey: KEY })).status, 403);
  assert.equal((await call(chatter, "DELETE")).status, 403);
  assert.equal((await (await call(owner, "GET")).json()).mode, "local-router");
  const saved = await call(owner, "PUT", { provider: "anthropic", model: "claude-x", apiKey: KEY });
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(KEY));
  assert.equal((await (await call(owner, "GET")).json()).provider, "anthropic");
  assert.equal((await call(owner, "PUT", { model: "a/b" })).status, 400);
  assert.equal((await call(owner, "DELETE")).status, 200);
  assert.equal((await (await call(owner, "GET")).json()).mode, "local-router");
});

test("a Project's owner sets its provider over HTTP, and nobody else's Project", async () => {
  const data = await mkdtemp(join(tmpdir(), "zv-prov-"));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: data }) });
  test.after(async () => { await zv.close(); await rm(data, { recursive: true, force: true }); });
  const root = { id: "root", type: "user", permissions: ["*"] };
  for (const id of ["site-a", "site-b"]) {
    const made = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, name: id, recipeName: "@zelavis/app", start: false }),
    }), { principal: root });
    assert.equal(made.status, 201);
  }
  const managerOfA = { id: "mgr", type: "user",
    grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "site-a" } }] };
  const call = (principal, projectId, method, body) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant/projects/${projectId}/provider`, {
      method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), { principal });

  assert.equal((await call(managerOfA, "site-b", "PUT", { model: "a/b", apiKey: KEY })).status, 403);
  assert.equal((await call(managerOfA, "site-b", "GET")).status, 403);
  assert.equal((await call(chatter, "site-a", "PUT", { model: "a/b", apiKey: KEY })).status, 403);
  assert.equal((await call(root, "ghost", "PUT", { model: "a/b", apiKey: KEY })).status, 404);

  const saved = await call(managerOfA, "site-a", "PUT", { provider: "openai", model: "gpt-a", apiKey: KEY });
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.ok(!text.includes(KEY));
  assert.equal(JSON.parse(text).source, "project");
  assert.equal((await (await call(managerOfA, "site-a", "GET")).json()).provider, "openai");
  assert.equal((await (await call(root, "site-b", "GET")).json()).source, "none");

  // Deleting the Project takes its key with it.
  const removed = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects/site-a", { method: "DELETE" }), { principal: root });
  if (removed.status !== 200) {
    const pending = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/projects/site-a"), { principal: root });
    assert.fail(`Project deletion failed: ${JSON.stringify((await pending.json()).project?.deletion)}`);
  }
  assert.equal((await (await call(root, "site-a", "GET")).json()).source, "none");
});

test("provider adapters speak each provider's own protocol", async () => {
  let seen;
  const capture = (reply) => async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(reply), { status: 200 });
  };

  const openai = createOpenAIModel({ apiKey: "k", model: "gpt-x", fetch: capture({ choices: [{ message: { content: "hi" } }] }) });
  assert.equal((await openai.generate({ messages: [{ role: "user", content: "x" }], tools: [] })).content, "hi");
  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.name, "openai:gpt-x");

  const anthropic = createAnthropicModel({
    apiKey: "sk-ant", model: "claude-x",
    fetch: capture({ content: [
      { type: "text", text: "Checking. " },
      { type: "tool_use", id: "tu1", name: "get_project", input: { projectId: "p1" } },
    ] }),
  });
  const result = await anthropic.generate({
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "look" },
      { role: "assistant", content: "ok", toolCalls: [
        { id: "a", name: "get_project", arguments: { projectId: "p1" } },
        { id: "b", name: "list_projects", arguments: {} },
      ] },
      { role: "tool", toolCallId: "a", content: '{"ok":true}' },
      { role: "tool", toolCallId: "b", content: '{"ok":true}' },
    ],
    tools: [{ name: "get_project", description: "d", parameters: { type: "object" } }],
  });
  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen.headers["x-api-key"], "sk-ant");
  assert.equal(seen.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.body.system, "be brief");
  assert.deepEqual(seen.body.tools, [{ name: "get_project", description: "d", input_schema: { type: "object" } }]);
  assert.deepEqual(seen.body.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(seen.body.messages[1].content.map((b) => b.type), ["text", "tool_use", "tool_use"]);
  assert.deepEqual(seen.body.messages[2].content.map((b) => [b.type, b.tool_use_id]),
    [["tool_result", "a"], ["tool_result", "b"]], "results of one step share one user turn");
  assert.equal(result.content, "Checking. ");
  assert.deepEqual(result.toolCalls, [{ id: "tu1", name: "get_project", arguments: { projectId: "p1" } }]);
});

test("Anthropic streaming yields text and assembles tool input across fragments", async () => {
  const encoder = new TextEncoder();
  const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const stream = [
    frame({ type: "message_start", message: {} }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }),
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }),
    frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu", name: "get_project" } }),
    frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"projec' } }),
    frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'tId":"p1"}' } }),
    frame({ type: "ping" }),
    frame({ type: "message_stop" }),
  ].join("");
  let request;
  const model = createAnthropicModel({
    apiKey: "k", model: "m",
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      // Split mid-line to exercise buffering.
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(encoder.encode(stream.slice(0, 40))); c.enqueue(encoder.encode(stream.slice(40))); c.close();
      } }));
    },
  });
  const deltas = [];
  const result = await model.generate({ messages: [{ role: "user", content: "x" }], tools: [], onText: (d) => deltas.push(d) });
  assert.equal(request.stream, true);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.toolCalls, [{ id: "tu", name: "get_project", arguments: { projectId: "p1" } }]);

  const failing = createAnthropicModel({ apiKey: "sk-secret", model: "m", fetch: async () => { throw new Error("Bearer sk-secret"); } });
  await assert.rejects(failing.generate({ messages: [], tools: [] }),
    (error) => !error.message.includes("sk-secret") && error.name === "AssistantModelError");
  const errored = createAnthropicModel({
    apiKey: "k", model: "m",
    fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: {"type":"error"}\n\n')); c.close(); } })),
  });
  await assert.rejects(errored.generate({ messages: [], tools: [], onText() {} }), /reported an error/);
  assert.throws(() => createAnthropicModel({ apiKey: "k", model: "m", url: "http://example.com/x" }), /HTTPS/);
  assert.throws(() => createOpenRouterModel({ apiKey: "", model: "m" }), /required/);
});
