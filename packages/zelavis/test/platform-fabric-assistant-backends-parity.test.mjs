// The Fabric, the Assistant, deployment backends and the Agent's status through the HTTP route, the SDK and the CLI, each against a
// Platform of its own: the same scenario has to answer the same, refusals included.
import assert from "node:assert/strict";
import test from "node:test";
import { runFabricCommand } from "../dist/cli/fabric.js";
import { runAssistantCommand } from "../dist/cli/assistant.js";
import { runBackendsCommand } from "../dist/cli/backends.js";
import { runAgentStatusCommand } from "../dist/cli/agent-status.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { outcome, platform } from "./_runtime.mjs";

/** Every surface's answers, in order, for one scenario written once per surface. */
const run = async (t, scenarios) => {
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t);
    const steps = scenarios(p)[surface];
    results[surface] = [];
    for (const step of steps) results[surface].push(await outcome(step));
  }
  return results;
};
/** Generated ids and cursors are named by what they are, so two Platforms' answers can be compared. */
const normalized = (value) => JSON.parse(JSON.stringify(value).replace(/(thread|msg|message|approval|run)[-_][A-Za-z0-9-]+/g, "$1_ID"));

test("the Fabric answers the same through HTTP, the SDK and the CLI", async (t) => {
  const results = await run(t, (p) => ({
    http: [() => p.send("GET", "/fabric/snapshot"), () => p.send("GET", "/fabric/health"), () => p.send("GET", "/fabric/nodes"), () => p.send("GET", "/fabric/nodes/nope"), () => p.send("GET", "/fabric/placements/projects"), () => p.send("GET", "/fabric/placements/projects/nope"), () => p.send("POST", "/fabric/placements/projects/plan", { requests: [] }), () => p.send("POST", "/fabric/placements/projects/plan", { requests: "bad" }), () => p.send("GET", "/fabric/migrations")],
    sdk: [() => p.client.fabric.snapshot(), () => p.client.fabric.health(), () => p.client.fabric.nodes(), () => p.client.fabric.node("nope"), () => p.client.fabric.placements(), () => p.client.fabric.placement("nope"), () => p.client.fabric.plan([]), () => p.client.fabric.plan("bad"), () => p.client.fabric.migrations()],
    cli: [() => p.cli(runFabricCommand, ["snapshot"]), () => p.cli(runFabricCommand, ["health"]), () => p.cli(runFabricCommand, ["nodes"]), () => p.cli(runFabricCommand, ["node", "nope"]), () => p.cli(runFabricCommand, ["placements"]), () => p.cli(runFabricCommand, ["placement", "nope"]), () => p.cli(runFabricCommand, ["plan", "--data", "[]"]), () => p.cli(runFabricCommand, ["plan", "--data", '"bad"']), () => p.cli(runFabricCommand, ["migrations"])],
  }));
  const accepted = results.http.filter((entry) => entry.answer !== undefined).length;
  assert.ok(accepted >= 6, `most of the scenario is accepted (${accepted})`);
  assert.deepEqual(normalized(results.sdk.map((e) => e.answer ? { answer: e.answer } : { refused: true })), normalized(results.http.map((e) => e.answer ? { answer: e.answer } : { refused: true })));
  assert.deepEqual(normalized(results.cli.map((e) => e.answer ? { answer: e.answer } : { refused: true })), normalized(results.http.map((e) => e.answer ? { answer: e.answer } : { refused: true })));
});

test("the Assistant answers the same through HTTP, the SDK and the CLI", async (t) => {
  const ids = {};
  const keep = (key) => (answer) => { ids[key] = answer.thread?.id ?? answer.id; return answer; };
  const results = await run(t, (p) => ({
    http: [
      () => p.send("GET", "/runtime/assistant/provider"),
      () => p.send("POST", "/runtime/assistant/threads", { title: "Check" }).then(keep("http")),
      () => p.send("GET", "/runtime/assistant/threads"),
      () => p.send("POST", `/runtime/assistant/threads/${ids.http}/messages`, { content: "hello" }),
      () => p.send("GET", `/runtime/assistant/threads/${ids.http}`),
      () => p.send("POST", `/runtime/assistant/threads/${ids.http}/approvals/none`, { decision: "approve" }),
      () => p.send("GET", "/runtime/assistant/audit?limit=5"),
      () => p.send("DELETE", `/runtime/assistant/threads/${ids.http}`),
      () => p.send("GET", `/runtime/assistant/threads/${ids.http}`),
    ],
    sdk: [
      () => p.client.assistant.provider(),
      () => p.client.assistant.createThread({ title: "Check" }).then(keep("sdk")),
      () => p.client.assistant.threads(),
      () => p.client.assistant.sendMessage(ids.sdk, "hello"),
      () => p.client.assistant.thread(ids.sdk),
      () => p.client.assistant.decide(ids.sdk, "none", { decision: "approve" }),
      () => p.client.assistant.audit({ limit: 5 }),
      () => p.client.assistant.deleteThread(ids.sdk),
      () => p.client.assistant.thread(ids.sdk),
    ],
    cli: [
      () => p.cli(runAssistantCommand, ["provider"]),
      () => p.cli(runAssistantCommand, ["create-thread", "--title", "Check"]).then(keep("cli")),
      () => p.cli(runAssistantCommand, ["threads"]),
      () => p.cli(runAssistantCommand, ["send", ids.cli, "hello"]),
      () => p.cli(runAssistantCommand, ["thread", ids.cli]),
      () => p.cli(runAssistantCommand, ["decide", ids.cli, "none", "--decision", "approve"]),
      () => p.cli(runAssistantCommand, ["audit", "--limit", "5"]),
      () => p.cli(runAssistantCommand, ["delete-thread", ids.cli]),
      () => p.cli(runAssistantCommand, ["thread", ids.cli]),
    ],
  }));
  const strip = (list) => normalized(list.map((entry) => entry.answer ? { answer: Object.keys(entry.answer).sort(), ok: true } : { refused: entry.refused }));
  assert.ok(results.http[1].answer && results.http[3].answer, JSON.stringify(results.http.slice(0, 4)));
  assert.ok(results.http[8].refused, "a deleted thread is gone");
  assert.deepEqual(strip(results.sdk), strip(results.http));
  assert.deepEqual(strip(results.cli), strip(results.http));
});

test("the Assistant's streamed reply is the same events through the SDK and the CLI as the route sends", async (t) => {
  const p = await platform(t);
  const created = await p.send("POST", "/runtime/assistant/threads", { title: "Stream" });
  const id = created.thread?.id ?? created.id;
  const events = [];
  for await (const event of p.client.assistant.streamMessage(id, "hello")) events.push(event.event);
  assert.ok(events.includes("done"), `the stream ends with done: ${events}`);
  const second = (await p.send("POST", "/runtime/assistant/threads", { title: "Stream 2" }));
  const viaCli = await p.cli(runAssistantCommand, ["stream", second.thread?.id ?? second.id, "hello"]);
  assert.deepEqual(viaCli.map((entry) => entry.event), events, "the CLI reads the same events");
});

test("a refused Assistant stream retains its HTTP status and a validated error message", async () => {
  for (const [body, message] of [[{ error: "Access refused" }, "Access refused"], [{ error: { private: true } }, "The Assistant stream answered 403."]]) {
    const client = createZelavisClient({ baseUrl: "http://zv.test", fetch: async () => Response.json(body, { status: 403 }) });
    await assert.rejects(async () => {
      for await (const _event of client.assistant.streamMessage("thread", "hello")) assert.fail("a refused stream emitted an event");
    }, error => {
      assert.equal(error._tag, "AssistantStreamError");
      assert.equal(error.status, 403);
      assert.equal(error.message, message);
      return true;
    });
  }
});

/** What a client call or a CLI command asked of the network: method, path under the API root, and body. */
const asked = async (call) => {
  const requests = [];
  const fetchImplementation = async (input, init) => { const url = new URL(String(input)); requests.push({ method: init?.method ?? "GET", path: url.pathname.replace("/zelavis/api/v1", "") + url.search, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }); return Response.json({}); };
  await call(fetchImplementation);
  return requests;
};
const viaSdk = (use) => asked((fetchImplementation) => use(createZelavisClient({ baseUrl: "http://zv.test", rootPath: "/zelavis", fetch: fetchImplementation })));
const viaCli = (command, args) => asked(async (fetchImplementation) => {
  const realFetch = globalThis.fetch, realLog = console.log;
  globalThis.fetch = fetchImplementation; console.log = () => {};
  try { await command([...args, "--url", "http://zv.test/zelavis", "--json"]); } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

test("deployment backends and the Agent's status are refused the same through HTTP, the SDK and the CLI when the Platform has none", async (t) => {
  const results = await run(t, (p) => ({
    http: [() => p.send("GET", "/runtime/deployment-backends"), () => p.send("GET", "/runtime/agent")],
    sdk: [() => p.client.deploymentBackends.list(), () => p.client.agent.status()],
    cli: [() => p.cli(runBackendsCommand, ["list"]), () => p.cli(runAgentStatusCommand, ["status"])],
  }));
  assert.deepEqual(results.http.map((entry) => entry.refused), ["Deployment backend management is unavailable.", "Agent operation journal is unavailable."]);
  assert.deepEqual(results.sdk.map((entry) => entry.refused?.includes("unavailable")), [true, true]);
  assert.deepEqual(results.cli.map((entry) => entry.refused?.includes("unavailable")), [true, true]);
});

test("every deployment backend and Agent operation asks the route for exactly the same through the SDK and the CLI", async () => {
  const cases = [
    [["GET", "/runtime/deployment-backends"], (c) => c.deploymentBackends.list(), runBackendsCommand, ["list"]],
    [["POST", "/runtime/deployment-backends/detect", {}], (c) => c.deploymentBackends.detect(), runBackendsCommand, ["detect"]],
    [["POST", "/runtime/deployment-backends/docker/enable", {}], (c) => c.deploymentBackends.enable("docker"), runBackendsCommand, ["enable", "docker"]],
    [["POST", "/runtime/deployment-backends/docker/disable", {}], (c) => c.deploymentBackends.disable("docker"), runBackendsCommand, ["disable", "docker"]],
    [["POST", "/runtime/deployment-backends/native/default", {}], (c) => c.deploymentBackends.setDefault("native"), runBackendsCommand, ["default", "native"]],
    [["GET", "/runtime/agent"], (c) => c.agent.status(), runAgentStatusCommand, ["status"]],
    [["GET", "/runtime/agent/operations"], (c) => c.agent.operations(), runAgentStatusCommand, ["operations"]],
    [["GET", "/runtime/agent/operations/op-1"], (c) => c.agent.operation("op-1"), runAgentStatusCommand, ["operation", "op-1"]],
  ];
  for (const [[method, path, body], sdk, command, args] of cases) {
    const expected = [{ method, path, body }];
    assert.deepEqual(await viaSdk(sdk), expected, `SDK ${method} ${path}`);
    assert.deepEqual(await viaCli(command, args), expected, `CLI ${method} ${path}`);
  }
});
