// Node enrollment over HTTP, the JS SDK and the CLI: one capability, three
// surfaces, the same results, errors and access rules.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { Effect } from "effect";

import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient, ZelavisClientHttpError } from "../dist/sdk/fetch.js";
import { runNodesCommand } from "../dist/cli/nodes.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { AGENT_TRUST_NAMESPACE, createNodeRoutes, publishAgentTrust } from "../dist/platform/node-routes.js";

const run = promisify(execFile);
const OWNER = { id: "owner", type: "user", permissions: ["*"] };
import { ZELAVIS_VERSION as VERSION } from "../dist/version.js";
const AGENT_URL = "https://127.0.0.1:9";
const TRUST = { keys: [{
  keyId: "platform-a", publicKey: Buffer.alloc(32, 7).toString("base64"),
  notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z",
}] };
let directory;
let certPem;
let certFile;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "zelavis-node-api-"));
  certFile = join(directory, "agent.crt");
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", join(directory, "agent.key"), "-out", certFile, "-days", "1", "-subj", "/CN=agent"]);
  certPem = await readFile(certFile, "utf8");
});

async function platform(t, { trust = true } = {}) {
  const store = createMemorySystemStore();
  if (trust) await Effect.runPromise(publishAgentTrust(store, TRUST));
  let principal = OWNER;
  const runtime = await zelavis({ systemStore: store, resolvePrincipal: () => principal });
  t.after(() => runtime.close());
  const through = (input, init) => runtime.fetch(new Request(input, init));
  const send = (method, path, body) => through(`http://localhost/zelavis/api/v1${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through });
  /** Runs `zelavis nodes ...` with its HTTP routed into this runtime; returns its JSON output. */
  const cli = async (...args) => {
    const realFetch = globalThis.fetch;
    const realLog = console.log;
    const lines = [];
    globalThis.fetch = through;
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await runNodesCommand([...args, "--url", "http://localhost/zelavis", "--json"]);
    } finally {
      globalThis.fetch = realFetch;
      console.log = realLog;
    }
    return lines.length ? JSON.parse(lines.join("\n")) : undefined;
  };
  return { store, runtime, send, client, cli, as: (next) => { principal = next; } };
}

const json = async (response) => ({ status: response.status, body: await response.json() });
const shape = (value) => Object.keys(value).sort();

test("the whole flow over HTTP: issue, enroll anonymously, list without credentials, revoke", async (t) => {
  const { send, as } = await platform(t);
  const issued = await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "node-a", ttlMinutes: 10 }));
  assert.equal(issued.status, 201);
  assert.deepEqual(shape(issued.body), ["expiresAt", "nodeId", "token"]);

  as(undefined);
  const enrolled = await json(await send("POST", "/runtime/nodes/enroll",
    { nodeId: "node-a", token: issued.body.token, certPem, url: AGENT_URL, version: VERSION }));
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  assert.deepEqual(enrolled.body, { nodeId: "node-a", agentId: "agent-node-a", trust: TRUST });

  as(OWNER);
  const listed = await json(await send("GET", "/runtime/nodes"));
  assert.equal(listed.status, 200);
  assert.deepEqual(shape(listed.body.nodes[0]), ["agentId", "certSha256", "compatibility", "enrolledAt", "nodeId", "state", "url", "version"],
    "no certificate, no internal version");
  assert.deepEqual([listed.body.nodes[0].version, listed.body.nodes[0].compatibility], [VERSION, "current"]);
  assert.deepEqual(listed.body.enrollments.map((e) => [e.nodeId, e.state]), [["node-a", "consumed"]]);
  assert.ok(!JSON.stringify(listed.body).includes(issued.body.token));
  assert.ok(!JSON.stringify(listed.body).toLowerCase().includes("tokenhash"));

  assert.deepEqual(await json(await send("DELETE", "/runtime/nodes/node-a")), { status: 200, body: { removed: true } });
  assert.equal((await json(await send("GET", "/runtime/nodes"))).body.nodes[0].state, "revoked");
});

test("HTTP, the SDK and the CLI return the same results for the same operations", async (t) => {
  const { send, client, cli } = await platform(t);
  const viaHttp = async (nodeId) => {
    const issued = (await json(await send("POST", "/runtime/nodes/enrollments", { nodeId }))).body;
    const enrolled = (await json(await send("POST", "/runtime/nodes/enroll", { nodeId, token: issued.token, certPem, url: AGENT_URL, version: VERSION }))).body;
    return { issued, enrolled, removed: (await json(await send("DELETE", `/runtime/nodes/${nodeId}`))).body };
  };
  const viaSdk = async (nodeId) => {
    const issued = await client.nodes.createEnrollment({ nodeId });
    const enrolled = await client.nodes.enroll({ nodeId, token: issued.token, certPem, url: AGENT_URL, version: VERSION });
    return { issued, enrolled, removed: await client.nodes.remove(nodeId) };
  };
  const viaCli = async (nodeId) => {
    const issued = await cli("enroll-token", nodeId);
    const enrolled = await cli("enroll", nodeId, "--enrollment-token", issued.token, "--cert-file", certFile, "--agent-url", AGENT_URL);
    return { issued, enrolled, removed: await cli("remove", nodeId) };
  };
  const results = { http: await viaHttp("n-http"), sdk: await viaSdk("n-sdk"), cli: await viaCli("n-cli") };
  for (const [surface, result] of Object.entries(results)) {
    assert.deepEqual(shape(result.issued), ["expiresAt", "nodeId", "token"], surface);
    assert.deepEqual(shape(result.enrolled), ["agentId", "nodeId", "trust"], surface);
    assert.deepEqual(result.enrolled.trust, TRUST, surface);
    assert.deepEqual(result.removed, { removed: true }, surface);
  }
  const listed = { http: (await json(await send("GET", "/runtime/nodes"))).body, sdk: await client.nodes.list(), cli: await cli("list") };
  assert.deepEqual(listed.sdk, listed.http);
  assert.deepEqual(listed.cli, listed.http);
  assert.deepEqual(listed.http.nodes.map((n) => [n.nodeId, n.state]), [["n-cli", "revoked"], ["n-http", "revoked"], ["n-sdk", "revoked"]]);
});

test("the same failures, with the same status and message, on all three surfaces", async (t) => {
  const { store, send, client, cli } = await platform(t);
  await send("POST", "/runtime/nodes/enrollments", { nodeId: "taken" });
  await store.set("fabric.project-ownership.v1", "project-a", { projectId: "project-a", nodeId: "busy", state: "active" });
  const enrolledBusy = await (async () => {
    const issued = (await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "busy" }))).body;
    return send("POST", "/runtime/nodes/enroll", { nodeId: "busy", token: issued.token, certPem, url: AGENT_URL, version: VERSION });
  })();
  assert.equal(enrolledBusy.status, 200);

  const wrongToken = "A".repeat(43);
  const cases = [
    { name: "duplicate pending enrollment", status: 409,
      http: () => send("POST", "/runtime/nodes/enrollments", { nodeId: "taken" }),
      sdk: () => client.nodes.createEnrollment({ nodeId: "taken" }), cli: () => cli("enroll-token", "taken") },
    { name: "invalid node id", status: 400,
      http: () => send("POST", "/runtime/nodes/enrollments", { nodeId: "Not Valid" }),
      sdk: () => client.nodes.createEnrollment({ nodeId: "Not Valid" }), cli: () => cli("enroll-token", "Not Valid") },
    { name: "wrong token", status: 403,
      http: () => send("POST", "/runtime/nodes/enroll", { nodeId: "taken", token: wrongToken, certPem, url: AGENT_URL, version: VERSION }),
      sdk: () => client.nodes.enroll({ nodeId: "taken", token: wrongToken, certPem, url: AGENT_URL, version: VERSION }),
      cli: () => cli("enroll", "taken", "--enrollment-token", wrongToken, "--cert-file", certFile, "--agent-url", AGENT_URL) },
    { name: "unknown node", status: 403,
      http: () => send("POST", "/runtime/nodes/enroll", { nodeId: "ghost", token: wrongToken, certPem, url: AGENT_URL, version: VERSION }),
      sdk: () => client.nodes.enroll({ nodeId: "ghost", token: wrongToken, certPem, url: AGENT_URL, version: VERSION }),
      cli: () => cli("enroll", "ghost", "--enrollment-token", wrongToken, "--cert-file", certFile, "--agent-url", AGENT_URL) },
    { name: "remove an unknown node", status: 404,
      http: () => send("DELETE", "/runtime/nodes/ghost"), sdk: () => client.nodes.remove("ghost"), cli: () => cli("remove", "ghost") },
    { name: "remove a node that still has Projects", status: 409,
      http: () => send("DELETE", "/runtime/nodes/busy"), sdk: () => client.nodes.remove("busy"), cli: () => cli("remove", "busy") },
  ];
  for (const { name, status, http, sdk, cli: viaCli } of cases) {
    const raw = await json(await http());
    assert.equal(raw.status, status, `${name}: http`);
    const failed = async (call) => {
      try { await call(); } catch (error) { return error; }
      return assert.fail(`${name}: expected a failure`);
    };
    const sdkError = await failed(sdk);
    assert.ok(sdkError instanceof ZelavisClientHttpError, name);
    assert.equal(sdkError.status, status, `${name}: sdk`);
    assert.equal(sdkError.message, raw.body.error, `${name}: sdk message`);
    assert.equal((await failed(viaCli)).message, raw.body.error, `${name}: cli message`);
  }
});

test("a refused enrollment says nothing about why, whatever the reason", async (t) => {
  const { send } = await platform(t);
  const issued = (await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "node-a" }))).body;
  const attempts = [
    { nodeId: "node-a", token: "A".repeat(43) },
    { nodeId: "missing", token: issued.token },
    { nodeId: "node-a", token: issued.token.replace(/.$/, (c) => (c === "A" ? "B" : "A")) },
  ];
  const bodies = [];
  for (const attempt of attempts) {
    const answered = await json(await send("POST", "/runtime/nodes/enroll", { ...attempt, certPem, url: AGENT_URL, version: VERSION }));
    assert.equal(answered.status, 403);
    bodies.push(JSON.stringify(answered.body));
  }
  assert.equal(new Set(bodies).size, 1, "every refusal reads the same");
});

test("access: enroll needs no session; every other route needs its own permission", async (t) => {
  const { send, as } = await platform(t);
  const call = async (principal, method, path, body) => { as(principal); return (await send(method, path, body)).status; };
  const nobody = { id: "nobody", type: "user", permissions: [] };
  for (const [method, path, body] of [["GET", "/runtime/nodes"], ["POST", "/runtime/nodes/enrollments", { nodeId: "x" }], ["DELETE", "/runtime/nodes/x"]]) {
    assert.equal(await call(undefined, method, path, body), 401, `anonymous ${method} ${path}`);
    assert.equal(await call(nobody, method, path, body), 403, `unprivileged ${method} ${path}`);
  }
  const viewer = { id: "viewer", type: "user", permissions: ["server.nodes.view"] };
  assert.equal(await call(viewer, "GET", "/runtime/nodes"), 200);
  assert.equal(await call(viewer, "POST", "/runtime/nodes/enrollments", { nodeId: "x" }), 403, "viewing is not enrolling");
  const issuer = { id: "issuer", type: "user", permissions: ["server.nodes.enroll"] };
  assert.equal(await call(issuer, "POST", "/runtime/nodes/enrollments", { nodeId: "x" }), 201);
  assert.equal(await call(issuer, "DELETE", "/runtime/nodes/x"), 403, "enrolling is not removing");
  const manager = { id: "manager", type: "user", permissions: ["server.nodes.manage"] };
  assert.equal(await call(manager, "DELETE", "/runtime/nodes/ghost"), 404, "allowed, and there is no such node");
  assert.equal(await call(undefined, "POST", "/runtime/nodes/enroll", {}), 400, "anonymous reaches enroll, which validates its input");
});

test("an installation that has not published trust keys does not accept nodes", async (t) => {
  const { send, client } = await platform(t, { trust: false });
  const issued = await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "node-a" }));
  assert.deepEqual([issued.status, issued.body.code], [409, "nodes-disabled"]);
  const enroll = await json(await send("POST", "/runtime/nodes/enroll", { nodeId: "node-a", token: "A".repeat(43), certPem, url: AGENT_URL, version: VERSION }));
  assert.deepEqual([enroll.status, enroll.body.code], [409, "nodes-disabled"]);
  assert.deepEqual(await client.nodes.list(), { nodes: [], enrollments: [] });
});

test("a node with Projects placed on it cannot be removed until they are released", async (t) => {
  const { store, send } = await platform(t);
  const issued = (await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "busy" }))).body;
  await send("POST", "/runtime/nodes/enroll", { nodeId: "busy", token: issued.token, certPem, url: AGENT_URL, version: VERSION });
  await store.set("fabric.project-ownership.v1", "project-a", { projectId: "project-a", nodeId: "busy", state: "active" });
  await store.set("fabric.project-ownership.v1", "project-b", { projectId: "project-b", nodeId: "other", state: "active" });
  const refused = await json(await send("DELETE", "/runtime/nodes/busy"));
  assert.deepEqual([refused.status, refused.body.code, refused.body.projects], [409, "node-in-use", ["project-a"]]);
  await store.set("fabric.project-ownership.v1", "project-a", { projectId: "project-a", nodeId: "busy", state: "released" });
  assert.equal((await send("DELETE", "/runtime/nodes/busy")).status, 200);
});

test("enrollment attempts are bounded, and the window reopens", async () => {
  const store = createMemorySystemStore();
  await Effect.runPromise(publishAgentTrust(store, TRUST));
  const clock = { now: 1_000_000 };
  const enroll = createNodeRoutes({ store, now: () => clock.now }).find((route) => route.id === "runtime.nodes.enroll");
  const attempt = () => enroll.handler({ body: { nodeId: "node-a", token: "A".repeat(43), certPem, url: AGENT_URL, version: VERSION } });
  for (let index = 0; index < 120; index++) assert.equal((await attempt()).status, 403, `attempt ${index + 1}`);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "60");
  clock.now += 60_001;
  assert.equal((await attempt()).status, 403, "a new window");
});

test("the host publishes only the Platform's public keys, and that turns enrollment on", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-host-"));
  const adapter = nodeAdapter({
    dataDirectory: data, services: false,
    projects: { directory: join(data, "projects"), remoteDispatch: { localNodeId: "local", nodes: {} } },
  });
  const constructorOptions = {};
  t.after(async () => { await adapter.close(constructorOptions); await rm(data, { recursive: true, force: true }); });
  const resolved = await adapter.resolve(constructorOptions);
  const published = await resolved.resources.systemStore.get(AGENT_TRUST_NAMESPACE, "platform");
  assert.ok(published.value.keys.length >= 1);
  for (const key of published.value.keys) {
    assert.deepEqual(shape(key), ["keyId", "notAfter", "notBefore", "publicKey"], "public fields only");
  }
  assert.ok(!JSON.stringify(published.value).toLowerCase().includes("private"));
});

test("the CLI writes trust keys for the Agent, and refuses missing or unknown options", async (t) => {
  const { cli } = await platform(t);
  const issued = await cli("enroll-token", "node-a", "--ttl-minutes", "30");
  const trustFile = join(directory, "trust.json");
  const result = await cli("enroll", "node-a", "--enrollment-token", issued.token, "--cert-file", certFile,
    "--agent-url", AGENT_URL, "--trust-out", trustFile);
  assert.deepEqual(JSON.parse(await readFile(trustFile, "utf8")), result.trust);
  await assert.rejects(() => cli("enroll", "node-a"), /--enrollment-token is required/);
  await assert.rejects(() => cli("enroll-token"), /A node id is required/);
  await assert.rejects(() => cli("list", "--bogus", "1"), /Unknown nodes option/);
  await assert.rejects(() => cli("enroll-token", "node-b", "--ttl-minutes", "0"), /whole number/);
  await assert.rejects(() => cli("frobnicate"), /Unknown nodes command/);
});

test("a worker newer than the Platform gets 409 worker-newer, and the credential still works afterwards", async (t) => {
  const { send, as } = await platform(t);
  const issued = await json(await send("POST", "/runtime/nodes/enrollments", { nodeId: "node-new" }));
  as(undefined);
  const newer = await json(await send("POST", "/runtime/nodes/enroll", { nodeId: "node-new", token: issued.body.token, certPem, url: AGENT_URL, version: "999.0.0" }));
  assert.deepEqual([newer.status, newer.body.code], [409, "worker-newer"]);
  const missing = await json(await send("POST", "/runtime/nodes/enroll", { nodeId: "node-new", token: issued.body.token, certPem, url: AGENT_URL }));
  assert.equal(missing.status, 400, "a version is required");
  const joined = await json(await send("POST", "/runtime/nodes/enroll", { nodeId: "node-new", token: issued.body.token, certPem, url: AGENT_URL, version: VERSION }));
  assert.equal(joined.status, 200);
});
