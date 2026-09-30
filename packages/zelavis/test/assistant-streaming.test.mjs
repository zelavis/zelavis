import assert from "node:assert/strict";
import test from "node:test";

import {
  Zelavis,
  createAssistantToolbox,
  createModelAssistantResponder,
  createOpenRouterModel,
  createProjectReadTools,
} from "../dist/index.js";

const owner = { id: "owner", type: "user", permissions: ["*"] };

function sse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const data = (value) => `data: ${JSON.stringify(value)}\n\n`;

test("OpenRouter streaming yields text deltas, joins tool call fragments and survives split lines", async () => {
  let request;
  const model = createOpenRouterModel({
    apiKey: "k", model: "m",
    fetch: async (_url, init) => {
      request = JSON.parse(init.body);
      const first = data({ choices: [{ delta: { content: "Hel" } }] });
      return sse([
        ": OPENROUTER PROCESSING\n\n",
        first.slice(0, 15), first.slice(15),
        data({ choices: [{ delta: { content: "lo" } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_project", arguments: '{"projec' } }] } }] }),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tId":"p1"}' } }] } }] }),
        "data: [DONE]\n\n",
      ]);
    },
  });
  const deltas = [];
  const result = await model.generate({ messages: [], tools: [], onText: (d) => deltas.push(d) });
  assert.equal(request.stream, true);
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(result.content, "Hello");
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "get_project", arguments: { projectId: "p1" } }]);

  const buffered = createOpenRouterModel({
    apiKey: "k", model: "m",
    fetch: async (_u, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }));
    },
  });
  await buffered.generate({ messages: [], tools: [] });
  assert.equal(request.stream, undefined, "no streaming unless a caller listens");

  const broken = createOpenRouterModel({
    apiKey: "k", model: "m", fetch: async () => sse(["data: {not json}\n\n"]),
  });
  await assert.rejects(broken.generate({ messages: [], tools: [], onText() {} }), /unreadable/);
  const empty = createOpenRouterModel({ apiKey: "k", model: "m", fetch: async () => sse(["data: [DONE]\n\n"]) });
  await assert.rejects(empty.generate({ messages: [], tools: [], onText() {} }), /no answer/);
});

test("the responder reports text and tool progress, and saves what it streamed", async () => {
  const steps = [
    async (input) => { input.onText("Checking. "); return { content: "Checking.", toolCalls: [{ id: "c", name: "list_projects", arguments: {} }] }; },
    async (input) => { input.onText("Two projects."); return { content: "Two projects.", toolCalls: [] }; },
  ];
  let index = 0;
  const model = { name: "m", generate: (input) => steps[index++](input) };
  const box = createAssistantToolbox({
    audit: async () => {},
    tools: createProjectReadTools(() => ({ list: async () => [{ id: "a" }, { id: "b" }] })),
  });
  const responder = createModelAssistantResponder({ model, toolbox: box });
  const events = [];
  const reply = await responder.respond({
    thread: { id: "t", ownerId: "owner", title: "", messages: [], createdAt: "", updatedAt: "" },
    prompt: "how many", principal: owner, onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.filter((e) => e.type === "tool"), [
    { type: "tool", id: "c", name: "list_projects", label: "Listing Projects", status: "running" },
    { type: "tool", id: "c", name: "list_projects", label: "Listing Projects", status: "done" },
  ]);
  assert.deepEqual(reply.activity, [{ label: "Listing Projects", status: "done" }]);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.delta).join("").replace(/\s+/g, " ").trim(),
    "Checking. Two projects.");
  assert.equal(reply.content, "Checking.\n\nTwo projects.");
});

async function readEvents(response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const [event, dataLine] = block.split("\n");
    return { event: event.slice(7), data: JSON.parse(dataLine.slice(6)) };
  });
}

function harness(assistantOption) {
  const zv = new Zelavis(assistantOption ? { assistant: assistantOption } : {});
  const call = (principal, path, init, signal) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, { ...init, ...(signal ? { signal } : {}) }),
    { principal });
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { zv, call, post };
}

test("the stream endpoint sends text, then the saved messages", async () => {
  const model = {
    name: "m",
    generate: async ({ onText }) => { onText("Hel"); onText("lo"); return { content: "Hello", toolCalls: [] }; },
  };
  const { call, post } = harness({ model });
  const created = await (await call(owner, "/threads", post({}))).json();
  const response = await call(owner, `/threads/${created.thread.id}/messages/stream`, post({ content: "hi" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = await readEvents(response);
  assert.deepEqual(events.filter((e) => e.event === "text").map((e) => e.data.delta), ["Hel", "lo"]);
  const done = events.at(-1);
  assert.equal(done.event, "done");
  assert.equal(done.data.assistantMessage.content, "Hello");
  const saved = await (await call(owner, `/threads/${created.thread.id}`)).json();
  assert.equal(saved.thread.messages.length, 2);
});

test("a responder that cannot stream still reaches a streaming caller", async () => {
  const { call, post } = harness();
  const created = await (await call(owner, "/threads", post({}))).json();
  const events = await readEvents(await call(owner, `/threads/${created.thread.id}/messages/stream`,
    post({ content: "show resources" })));
  assert.equal(events[0].event, "text");
  assert.equal(events.at(-1).event, "done");
  assert.equal(events.at(-1).data.assistantMessage.actions[0].to, "/server/resources");
});

test("refusals happen with a real status before any stream opens", async () => {
  const { call, post } = harness();
  const alice = { id: "alice", type: "user", permissions: ["assistant.use"],
    grants: [{ permission: "project.view", scope: { type: "project", projectId: "p1" } }] };
  const bob = { id: "bob", type: "user", permissions: ["assistant.use"] };
  const created = await (await call(alice, "/threads", post({ projectId: "p1" }))).json();
  const path = `/threads/${created.thread.id}/messages/stream`;

  assert.equal((await call(bob, path, post({ content: "hi" }))).status, 404);
  assert.equal((await call({ ...alice, grants: [] }, path, post({ content: "hi" }))).status, 403);
  assert.equal((await call(alice, path, post({ content: "  " }))).status, 400);
  assert.equal((await call(alice, "/threads/none/messages/stream", post({ content: "hi" }))).status, 404);
  assert.equal((await call({ id: "x", type: "user", permissions: [] }, path, post({ content: "hi" }))).status, 403);
});

test("a failing model ends the stream with a safe error event", async () => {
  const model = { name: "m", generate: async () => { throw new Error("internal detail sk-secret"); } };
  const { call, post } = harness({ model });
  const created = await (await call(owner, "/threads", post({}))).json();
  const events = await readEvents(await call(owner, `/threads/${created.thread.id}/messages/stream`, post({ content: "hi" })));
  const error = events.at(-1);
  assert.equal(error.event, "error");
  assert.ok(!JSON.stringify(error).includes("sk-secret"));
  const saved = await (await call(owner, `/threads/${created.thread.id}`)).json();
  assert.equal(saved.thread.messages.length, 0, "a failed turn saves nothing");
});

test("cancelling the stream aborts the model call", async () => {
  let aborted;
  const model = {
    name: "m",
    generate: ({ signal, onText }) => new Promise((_resolve, reject) => {
      onText("partial");
      aborted = new Promise((done) => signal.addEventListener("abort", () => { done(true); reject(signal.reason); }));
    }),
  };
  const { call, post } = harness({ model });
  const created = await (await call(owner, "/threads", post({}))).json();
  const response = await call(owner, `/threads/${created.thread.id}/messages/stream`, post({ content: "hi" }));
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /partial/);
  await reader.cancel();
  assert.equal(await Promise.race([aborted, new Promise((r) => setTimeout(() => r("timeout"), 2000))]), true);
});

test("tool activity is described in operator language, refusals included, and saved with the reply", async () => {
  let step = 0;
  const model = {
    name: "m",
    generate: async () => step++ === 0
      ? { content: "", toolCalls: [
          { id: "1", name: "get_project", arguments: { projectId: "p9" } },
          { id: "2", name: "get_project", arguments: {} },
          { id: "3", name: "drop_everything", arguments: {} },
        ] }
      : { content: "done", toolCalls: [] },
  };
  const { call, post } = harness({ model });
  const viewer = { id: "v", type: "user", permissions: ["assistant.use"],
    grants: [{ permission: "project.view", scope: { type: "project", projectId: "p1" } }] };
  const created = await (await call(viewer, "/threads", post({}))).json();
  const events = await readEvents(await call(viewer, `/threads/${created.thread.id}/messages/stream`,
    post({ content: "look" })));
  const tools = events.filter((e) => e.event === "tool").map((e) => [e.data.id, e.data.label, e.data.status]);
  assert.deepEqual(tools, [
    ["1", "Reading Project p9", "running"], ["1", "Reading Project p9", "refused"],
    ["2", "Get project", "running"], ["2", "Get project", "refused"],
    ["3", "Drop everything", "running"], ["3", "Drop everything", "refused"],
  ]);
  const saved = await (await call(viewer, `/threads/${created.thread.id}`)).json();
  assert.deepEqual(saved.thread.messages.at(-1).activity.map((a) => a.status), ["refused", "refused", "refused"]);
});
