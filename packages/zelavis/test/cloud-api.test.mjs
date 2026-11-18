import assert from "node:assert/strict";
import test from "node:test";
import { zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { runCloudCommand } from "../dist/cli/cloud.js";
import { createCloudCapacityController } from "../dist/platform/cloud-capacity.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const POLICY = { location: "nbg1", image: "ubuntu-24.04", maxNodes: 2, machineClasses: [{ name: "cpx11", cpuCores: 2, memoryBytes: 2 * 1024 ** 3, diskBytes: 40 * 1024 ** 3 }] };
const TOKEN = "hcloud_token_0123456789abcdef";
const OWNER = { id: "owner", type: "user", permissions: ["*"] };

function fakeProvider() {
  const nodes = new Map();
  return {
    list: async () => [...nodes.values()],
    get: async (id) => nodes.get(id),
    provision: async (input) => { const node = { id: `node-${input.requestId}`, provider: "hetzner", state: "provisioning", ...(input.region ? { region: input.region } : {}) }; nodes.set(node.id, node); return node; },
    release: async (id) => { nodes.delete(id); },
  };
}

async function platform(t, { controller = true } = {}) {
  const store = createMemorySystemStore();
  await store.set("fabric.cloud-policy.v1", "default", { schemaVersion: 1, policy: POLICY, updatedAt: 1, updatedBy: "owner" });
  const provider = fakeProvider();
  const cloudCapacity = controller ? createCloudCapacityController({
    store, masterSecret: "secret", platformId: "p1",
    buildProvider: () => provider, firstBootFor: async () => "#!/bin/sh\n",
  }) : undefined;
  let principal = OWNER;
  const runtime = await zelavis({ systemStore: store, resolvePrincipal: () => principal, ...(cloudCapacity ? { cloudCapacity } : {}) });
  t.after(() => runtime.close());
  const through = (input, init) => runtime.fetch(new Request(input, init));
  const send = (method, path, body) => through(`http://localhost/zelavis/api/v1${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through });
  const cli = async (...args) => {
    const realFetch = globalThis.fetch; const realLog = console.log; const lines = [];
    globalThis.fetch = through; console.log = (...parts) => lines.push(parts.join(" "));
    process.env.ZELAVIS_CLOUD_TOKEN = TOKEN;
    try { await runCloudCommand([...args, "--url", "http://localhost/zelavis", "--json"]); }
    finally { globalThis.fetch = realFetch; console.log = realLog; delete process.env.ZELAVIS_CLOUD_TOKEN; }
    return lines.length ? JSON.parse(lines.join("\n")) : undefined;
  };
  return { send, client, cli, as: (next) => { principal = next; } };
}
const json = async (response) => ({ status: response.status, body: await response.json() });

test("connect, request, list and release over HTTP never expose the token", async (t) => {
  const { send } = await platform(t);
  assert.deepEqual((await json(await send("GET", "/runtime/cloud"))).body, { connection: null });
  const connected = await json(await send("POST", "/runtime/cloud/connection", { provider: "hetzner", token: TOKEN, label: "prod" }));
  assert.equal(connected.status, 201);
  const requested = await json(await send("POST", "/runtime/cloud/nodes", { requestId: "r1", region: "fsn1" }));
  assert.deepEqual([requested.status, requested.body.node.id], [202, "node-r1"]);
  assert.equal((await json(await send("DELETE", "/runtime/cloud/connection"))).status, 409, "machines still exist");
  assert.equal((await json(await send("DELETE", "/runtime/cloud/nodes/node-r1"))).body.released, true);
  assert.equal((await json(await send("DELETE", "/runtime/cloud/connection"))).body.disconnected, true);
  for (const response of [connected, requested]) assert.ok(!JSON.stringify(response.body).includes(TOKEN));
});

test("HTTP, the SDK and the CLI agree", async (t) => {
  const { client, cli, send } = await platform(t);
  const sdk = {
    connected: await client.cloud.connect({ provider: "hetzner", token: TOKEN, label: "a" }),
    node: await client.cloud.requestNode({ requestId: "x1" }),
    nodes: await client.cloud.nodes(),
    released: await client.cloud.releaseNode("node-x1"),
    disconnected: await client.cloud.disconnect(),
  };
  const cliOut = {
    connected: (await cli("connect", "--label", "a")).connection,
    node: (await cli("request", "x1")).node,
    nodes: (await cli("nodes")).nodes,
    released: await cli("release", "node-x1"),
    disconnected: await cli("disconnect"),
  };
  assert.deepEqual(Object.keys(sdk.connected).sort(), Object.keys(cliOut.connected).sort());
  assert.deepEqual(sdk.node, cliOut.node);
  assert.deepEqual(sdk.nodes, cliOut.nodes);
  assert.deepEqual(sdk.released, cliOut.released);
  assert.deepEqual(sdk.disconnected, cliOut.disconnected);
  assert.deepEqual(await client.cloud.connection(), null);
  assert.equal((await json(await send("GET", "/runtime/cloud"))).status, 200);
});

test("validation failures carry the same domain code on every surface", async (t) => {
  const { client, send } = await platform(t);
  const http = await json(await send("POST", "/runtime/cloud/connection", { provider: "aws", token: TOKEN }));
  assert.deepEqual([http.status, http.body.code], [400, "invalid-request"]);
  await assert.rejects(client.cloud.connect({ provider: "aws", token: TOKEN }), (error) => error.status === 400);
  assert.equal((await json(await send("POST", "/runtime/cloud/nodes", { requestId: "r" }))).body.code, "not-connected");
});

test("each route needs its own permission, and the system answers 503 without a controller", async (t) => {
  const { send, as } = await platform(t);
  as({ id: "viewer", type: "user", permissions: ["server.cloud.view"] });
  assert.equal((await send("GET", "/runtime/cloud")).status, 200);
  assert.equal((await send("POST", "/runtime/cloud/nodes", { requestId: "r" })).status, 403);
  assert.equal((await send("POST", "/runtime/cloud/connection", { provider: "hetzner", token: TOKEN })).status, 403);
  as({ id: "manager", type: "user", permissions: ["server.cloud.manage"] });
  assert.equal((await send("POST", "/runtime/cloud/connection", { provider: "hetzner", token: TOKEN })).status, 403, "managing is not connecting");
  as(undefined);
  assert.ok([401, 403].includes((await send("GET", "/runtime/cloud")).status));

  const bare = await platform(t, { controller: false });
  const unavailable = await json(await bare.send("GET", "/runtime/cloud"));
  assert.deepEqual([unavailable.status, unavailable.body.code], [503, "cloud-unavailable"]);
});

test("scaling consent is the same on HTTP, the SDK and the CLI, and needs the strongest permission", async (t) => {
  const { send, client, cli, as } = await platform(t);
  assert.equal((await json(await send("PUT", "/runtime/cloud/scaling", { consent: true, maxMachines: 1, cooldownMinutes: 5 }))).body.code, "not-connected");
  await client.cloud.connect({ provider: "hetzner", token: TOKEN });
  assert.equal((await client.cloud.scaling()).settings.consent, false, "off until a person turns it on");

  const http = await json(await send("PUT", "/runtime/cloud/scaling", { consent: true, maxMachines: 3, cooldownMinutes: 20 }));
  assert.equal(http.status, 200);
  const viaSdk = await client.cloud.setScaling({ consent: true, maxMachines: 3, cooldownMinutes: 20 });
  const viaCli = (await cli("scaling", "--enable", "--max-machines", "3", "--cooldown-minutes", "20")).settings;
  for (const settings of [http.body.settings, viaSdk, viaCli]) {
    assert.deepEqual([settings.consent, settings.maxMachines, settings.cooldownMinutes], [true, 3, 20]);
  }
  assert.equal((await cli("scaling", "--disable")).settings.maxMachines, 3, "unspecified limits are kept");
  assert.equal((await client.cloud.scaling()).settings.consent, false);

  const invalid = await json(await send("PUT", "/runtime/cloud/scaling", { consent: true, maxMachines: 0, cooldownMinutes: 5 }));
  assert.deepEqual([invalid.status, invalid.body.code], [400, "invalid-request"]);

  as({ id: "viewer", type: "user", permissions: ["server.cloud.view"] });
  assert.equal((await send("GET", "/runtime/cloud/scaling")).status, 200);
  assert.equal((await send("PUT", "/runtime/cloud/scaling", { consent: true, maxMachines: 1, cooldownMinutes: 5 })).status, 403);
  as({ id: "manager", type: "user", permissions: ["server.cloud.manage"] });
  assert.equal((await send("PUT", "/runtime/cloud/scaling", { consent: true, maxMachines: 1, cooldownMinutes: 5 })).status, 403, "managing machines is not consenting to spend");
});


test("stored policy enforces authority, validates bounds and rejects stale revisions", async t => {
  const { send, as } = await platform(t);
  as({ id: "viewer", type: "user", permissions: ["server.cloud.view"] });
  assert.equal((await send("PUT", "/runtime/cloud/policy", { policy: POLICY })).status, 403);
  as(OWNER);
  const first = await json(await send("GET", "/runtime/cloud/policy"));
  const saved = await json(await send("PUT", "/runtime/cloud/policy", { policy: { ...POLICY, maxNodes: 3 }, expectedUpdatedAt: first.body.updatedAt }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.policy.maxNodes, 3);
  const stale = await json(await send("PUT", "/runtime/cloud/policy", { policy: POLICY, expectedUpdatedAt: first.body.updatedAt }));
  assert.deepEqual([stale.status, stale.body.code], [409, "invalid-request"]);
  assert.match(stale.body.error, /reload/);
  const bad = await json(await send("PUT", "/runtime/cloud/policy", { policy: { ...POLICY, maxNodes: 101 } }));
  assert.equal(bad.status, 400); assert.match(bad.body.error, /100/);
});


test("webhook connections need an HTTPS endpoint and a long signing secret; other providers refuse endpoints", async t => {
  const { send } = await platform(t);
  const signing = "signing-secret-012345678901234567890123";
  for (const body of [{ provider: "webhook", token: signing }, { provider: "webhook", token: signing, endpoint: "http://webhook.test" }, { provider: "webhook", token: TOKEN, endpoint: "https://webhook.test" }, { provider: "hetzner", token: TOKEN, endpoint: "https://webhook.test" }]) {
    assert.equal((await send("POST", "/runtime/cloud/connection", body)).status, 400);
  }
  const connected = await json(await send("POST", "/runtime/cloud/connection", { provider: "webhook", token: signing, endpoint: "https://webhook.test/capacity" }));
  assert.equal(connected.status, 201); assert.equal(connected.body.connection.endpoint, "https://webhook.test/capacity");
});


test("policy and webhook fields have SDK and CLI parity", async t => {
  const { client, cli } = await platform(t);
  const initial = await client.cloud.policy();
  const saved = await client.cloud.setPolicy({ ...POLICY, maxNodes: 4 }, { expectedUpdatedAt: initial.updatedAt });
  assert.deepEqual(await cli("policy"), saved);
  const changed = await cli("set-policy", "--data", JSON.stringify(POLICY), "--expected-updated-at", String(saved.updatedAt));
  assert.deepEqual(await client.cloud.policy(), changed);
  await assert.rejects(client.cloud.setPolicy(POLICY, { expectedUpdatedAt: saved.updatedAt }), error => error.status === 409);
  process.env.ZELAVIS_CLOUD_TOKEN = "signing-secret-01234567890123456789";
  // cli fixture supplies its existing test token; use SDK for the longer webhook signing secret.
  const connected = await client.cloud.connect({ provider: "webhook", token: "signing-secret-01234567890123456789", endpoint: "https://webhook.test/capacity" });
  assert.equal(connected.endpoint, "https://webhook.test/capacity");
  assert.deepEqual((await cli("status")).connection, connected);
  delete process.env.ZELAVIS_CLOUD_TOKEN;
});
