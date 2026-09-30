import assert from "node:assert/strict";
import test from "node:test";

import {
  AssistantToolArgumentError,
  createAssistantToolbox,
  createModelAssistantResponder,
  createOpenRouterModel,
  createProjectReadTools,
  createMemorySystemStore,
  createAssistantManager,
  Zelavis,
} from "../dist/index.js";

const projectsManager = {
  list: async () => [{ id: "p1" }, { id: "p2" }],
  get: async (id) => ({ id }),
  logs: async (id) => [`log for ${id}`],
};

function toolbox(audit = async () => {}, tools = createProjectReadTools(() => projectsManager)) {
  return createAssistantToolbox({ tools, audit });
}

const viewsP1 = {
  id: "u1", type: "user",
  grants: [
    { permission: "project.view", scope: { type: "project", projectId: "p1" } },
  ],
};
const admin = { id: "root", type: "user", permissions: ["*"] };

test("tools are advertised only to callers who could use them", () => {
  const box = toolbox();
  assert.deepEqual(box.advertise(viewsP1).map((t) => t.name), ["get_project"]);
  assert.deepEqual(
    box.advertise(admin).map((t) => t.name).sort(),
    ["get_project", "list_projects", "project_logs"],
  );
  assert.deepEqual(box.advertise({ id: "nobody", type: "user" }), []);
});

test("authority comes from the call's arguments, not from what was advertised", async () => {
  const box = toolbox();
  const own = await box.run(viewsP1, { name: "get_project", arguments: { projectId: "p1" } });
  assert.equal(own.ok, true);

  const other = await box.run(viewsP1, { name: "get_project", arguments: { projectId: "p2" } });
  assert.equal(other.ok, false);
  assert.equal(other.refusal.code, "forbidden");
  assert.deepEqual(other.refusal.requires.scope, { type: "project", projectId: "p2" });

  // A tool that was never advertised is still gated at execution.
  const hidden = await box.run(viewsP1, { name: "list_projects", arguments: {} });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.refusal.code, "forbidden");
});

test("malformed arguments and unknown tools are structured refusals", async () => {
  const box = toolbox();
  for (const args of [undefined, null, "p1", [], {}, { projectId: 7 }, { projectId: "" }]) {
    const result = await box.run(admin, { name: "get_project", arguments: args });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.refusal.code, "invalid_arguments");
  }
  const unknown = await box.run(admin, { name: "drop_everything", arguments: {} });
  assert.equal(unknown.refusal.code, "unknown_tool");
});

test("every call is audited with principal, arguments and decision", async () => {
  const records = [];
  const box = toolbox(async (record) => { records.push(record); });
  await box.run(viewsP1, { name: "get_project", arguments: { projectId: "p1" } });
  await box.run(viewsP1, { name: "get_project", arguments: { projectId: "p2" } });
  await box.run(viewsP1, { name: "get_project", arguments: {} });
  assert.deepEqual(
    records.map((r) => [r.principalId, r.tool, r.decision]),
    [["u1", "get_project", "allowed"], ["u1", "get_project", "denied"], ["u1", "get_project", "invalid"]],
  );
  assert.equal(JSON.parse(records[1].arguments).projectId, "p2");
});

test("a call that cannot be audited does not run", async () => {
  let ran = false;
  const box = createAssistantToolbox({
    audit: async () => { throw new Error("store down"); },
    tools: [{
      name: "touch", description: "", parameters: { type: "object" },
      advertisedPermissions: ["x"],
      access: (args) => ({ permissions: ["x"], parsed: args }),
      execute: async () => { ran = true; return {}; },
    }],
  });
  const result = await box.run({ id: "u", type: "user", permissions: ["x"] },
    { name: "touch", arguments: {} });
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "audit_unavailable");
  assert.equal(ran, false);
});

test("a failing tool reports a refusal instead of ending the run, and oversized results are cut", async () => {
  const box = createAssistantToolbox({
    audit: async () => {},
    tools: [
      { name: "boom", description: "", parameters: { type: "object" }, advertisedPermissions: [],
        access: () => ({ permissions: [], parsed: {} }),
        execute: async () => { throw new Error("nope"); } },
      { name: "big", description: "", parameters: { type: "object" }, advertisedPermissions: [],
        access: () => ({ permissions: [], parsed: {} }),
        execute: async () => "x".repeat(100_000) },
    ],
  });
  const boom = await box.run(admin, { name: "boom", arguments: {} });
  assert.equal(boom.refusal.code, "failed");
  const big = await box.run(admin, { name: "big", arguments: {} });
  assert.equal(big.truncated, true);
  assert.ok(big.value.length < 20_000);
  assert.throws(() => { throw new AssistantToolArgumentError("x"); }, /x/);
});

function scriptedModel(script) {
  const seen = [];
  return {
    seen,
    name: "scripted",
    async generate(input) {
      seen.push(input);
      return script[Math.min(seen.length - 1, script.length - 1)](input);
    },
  };
}

test("the model responder runs tools with the caller's authority and relays refusals", async () => {
  const model = scriptedModel([
    () => ({ content: "", toolCalls: [{ id: "c1", name: "get_project", arguments: { projectId: "p2" } }] }),
    () => ({ content: "You cannot view p2.", toolCalls: [] }),
  ]);
  const responder = createModelAssistantResponder({ model, toolbox: toolbox() });
  const thread = { id: "t", ownerId: "u1", title: "", messages: [
    { id: "m", role: "user", content: "show p2", createdAt: "" }], createdAt: "", updatedAt: "" };
  const reply = await responder.respond({ thread, prompt: "show p2", principal: viewsP1 });

  assert.equal(reply.content, "You cannot view p2.");
  assert.deepEqual(model.seen[0].tools.map((t) => t.name), ["get_project"]);
  const toolMessage = model.seen[1].messages.find((m) => m.role === "tool");
  assert.equal(JSON.parse(toolMessage.content).refusal.code, "forbidden");
});

test("a model that keeps calling tools is stopped", async () => {
  const model = scriptedModel([
    () => ({ content: "", toolCalls: [{ id: "c", name: "list_projects", arguments: {} }] }),
  ]);
  const responder = createModelAssistantResponder({ model, toolbox: toolbox(), maxSteps: 3 });
  const thread = { id: "t", ownerId: "root", title: "", messages: [], createdAt: "", updatedAt: "" };
  const reply = await responder.respond({ thread, prompt: "x", principal: admin });
  assert.equal(model.seen.length, 3);
  assert.deepEqual(model.seen[2].tools, [], "the last step offers no tools");
  assert.match(reply.content, /allowed number of steps/);
});

test("OpenRouter adapter maps messages, tools and tool calls, and never echoes the key", async () => {
  let request;
  const model = createOpenRouterModel({
    apiKey: "sk-secret", model: "vendor/model",
    fetch: async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: {
        content: null,
        tool_calls: [{ id: "a", type: "function", function: { name: "get_project", arguments: '{"projectId":"p1"}' } },
          { id: "b", type: "function", function: { name: "get_project", arguments: "{not json" } }],
      } }] }), { status: 200 });
    },
  });
  const result = await model.generate({
    messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
    tools: [{ name: "get_project", description: "d", parameters: { type: "object" } }],
  });
  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.init.headers.authorization, "Bearer sk-secret");
  assert.equal(request.body.tools[0].function.name, "get_project");
  assert.deepEqual(result.toolCalls[0], { id: "a", name: "get_project", arguments: { projectId: "p1" } });
  assert.equal(result.toolCalls[1].arguments, "{not json");

  const failing = createOpenRouterModel({
    apiKey: "sk-secret", model: "m",
    fetch: async () => { throw new Error("connect failed with Bearer sk-secret"); },
  });
  await assert.rejects(failing.generate({ messages: [], tools: [] }),
    (error) => !error.message.includes("sk-secret") && error.name === "AssistantModelError");
  const refused = createOpenRouterModel({
    apiKey: "k", model: "m", fetch: async () => new Response("no", { status: 401 }),
  });
  await assert.rejects(refused.generate({ messages: [], tools: [] }), /401/);
  assert.throws(() => createOpenRouterModel({ apiKey: "k", model: "m", url: "http://example.com/x" }), /HTTPS/);
});

test("Zelavis wires a model to the caller's authority and audits in its System Store", async () => {
  const model = scriptedModel([
    () => ({ content: "", toolCalls: [{ id: "c1", name: "list_projects", arguments: {} }] }),
    () => ({ content: "done", toolCalls: [] }),
  ]);
  const zv = new Zelavis({ assistant: { model } });
  const principal = { id: "chatter", type: "user", permissions: ["assistant.use"] };
  const call = (path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, init), { principal });
  const created = await (await call("/threads", { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" })).json();
  const response = await call(`/threads/${created.thread.id}/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "list them" }) });
  assert.equal(response.status, 201);
  assert.deepEqual(model.seen[0].tools, [], "chat permission alone advertises nothing");
  const toolMessage = model.seen[1].messages.find((m) => m.role === "tool");
  assert.equal(JSON.parse(toolMessage.content).refusal.code, "forbidden");
});
