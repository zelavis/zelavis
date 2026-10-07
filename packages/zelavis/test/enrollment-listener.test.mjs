import assert from "node:assert/strict";
import { mkdtemp, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createEnrollmentListener } from "../dist/adapters/_enrollment-listener.js";
import { createPinnedFetch } from "../dist/adapters/_pinned-fetch.js";
import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { fingerprintOf, loadOrCreatePlatformTls } from "../dist/adapters/_platform-tls.js";
import { publishAgentTrust } from "../dist/platform/node-routes.js";

const run = (effect) => Effect.runPromise(effect);
const TRUST = { keys: [{ keyId: "k1", publicKey: "A".repeat(43), notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z" }] };
const OWNER = { id: "owner", type: "user", permissions: ["*"] };
const ENROLL = "/zelavis/api/v1/runtime/nodes/enroll";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-enroll-listener-"));
  await chmod(directory, 0o700);
  const tls = await run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1", "localhost"] }));
  const store = createMemorySystemStore();
  await run(publishAgentTrust(store, TRUST));
  let principal = OWNER;
  const runtime = await zelavis({ systemStore: store, resolvePrincipal: () => principal });
  t.after(() => runtime.close());
  const seen = [];
  const listener = await run(createEnrollmentListener({
    fetch: (request) => { seen.push(new URL(request.url).pathname); return runtime.fetch(request); },
    isEnrollmentPath: (pathname) => pathname === ENROLL,
    tls, host: "127.0.0.1", port: 0,
  }));
  t.after(() => run(listener.close));
  const base = `https://127.0.0.1:${listener.port}`;
  const pinned = createPinnedFetch({ fingerprint: tls.fingerprint });
  const issue = async (nodeId) => (await (await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/nodes/enrollments", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId }),
  }))).json()).token;
  return { tls, base, pinned, seen, issue, as: (next) => { principal = next; }, directory };
}

test("a machine enrolls over TLS by pinning the Platform's own certificate", async (t) => {
  const { base, pinned, issue, tls, as } = await setup(t);
  const token = await issue("node-a");
  as(undefined);
  const agent = generateAgentCertificate({ names: ["203.0.113.9"] });
  const response = await pinned(`${base}${ENROLL}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "node-a", token, certPem: agent.certPem, url: "https://203.0.113.9:8443" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { nodeId: "node-a", agentId: "agent-node-a", trust: TRUST });
  assert.match(tls.fingerprint, /^[0-9a-f]{64}$/);
});

test("a wrong pin sends nothing, and only the enrollment path ever reaches the runtime", async (t) => {
  const { base, pinned, seen } = await setup(t);
  const wrong = createPinnedFetch({ fingerprint: "ab".repeat(32) });
  await assert.rejects(wrong(`${base}${ENROLL}`, { method: "POST", body: "{}" }), /pinned fingerprint/);
  assert.deepEqual(seen, []);

  for (const [method, path, status] of [["GET", ENROLL, 405], ["POST", "/zelavis/api/v1/runtime/nodes", 404],
    ["GET", "/zelavis/", 404], ["POST", "/zelavis/api/v1/runtime/cloud/connection", 404]]) {
    const response = await pinned(`${base}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, status, `${method} ${path}`);
  }
  assert.deepEqual(seen, [], "nothing but the enroll route is forwarded");
});

test("an oversized body is refused before it is read in full", async (t) => {
  const { base, pinned, seen } = await setup(t);
  const response = await pinned(`${base}${ENROLL}`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70_000) });
  assert.equal(response.status, 413);
  assert.deepEqual(seen, []);
});

test("the identity is created once, kept private, reused, and renewed when it stops covering the addresses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-platform-tls-"));
  await chmod(directory, 0o700);
  const first = await run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1"] }));
  assert.equal(((await stat(join(directory, "platform-tls.key"))).mode & 0o777), 0o600);
  const again = await run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1"] }));
  assert.equal(again.fingerprint, first.fingerprint);
  assert.equal(first.fingerprint, fingerprintOf(first.certPem));
  const wider = await run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1", "panel.example.com"] }));
  assert.notEqual(wider.fingerprint, first.fingerprint, "a new address needs a new certificate");

  await chmod(join(directory, "platform-tls.key"), 0o644);
  await assert.rejects(run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1", "panel.example.com"] })), /readable by others/);
  await chmod(directory, 0o755);
  await assert.rejects(run(loadOrCreatePlatformTls({ directory, names: ["127.0.0.1"] })), /private directory/);
});

test("the enrollment endpoint is published for operators and agrees on every surface", async () => {
  const { publishEnrollmentEndpoint } = await import("../dist/platform/node-routes.js");
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runNodesCommand } = await import("../dist/cli/nodes.js");
  const store = createMemorySystemStore();
  const runtime = await zelavis({ systemStore: store, resolvePrincipal: () => OWNER });
  try {
    const through = (input, init) => runtime.fetch(new Request(input, init));
    const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch: through });
    assert.equal(await client.nodes.platform(), null);
    const endpoint = { url: "https://203.0.113.5:8444", fingerprint: "cd".repeat(32) };
    await run(publishEnrollmentEndpoint(store, endpoint));
    assert.deepEqual(await client.nodes.platform(), endpoint);
    const http = await (await through("http://localhost/zelavis/api/v1/runtime/nodes/platform")).json();
    assert.deepEqual(http, { endpoint });
    const realFetch = globalThis.fetch; const realLog = console.log; const lines = [];
    globalThis.fetch = through; console.log = (...parts) => lines.push(parts.join(" "));
    try { await runNodesCommand(["platform", "--url", "http://localhost/zelavis", "--json"]); }
    finally { globalThis.fetch = realFetch; console.log = realLog; }
    assert.deepEqual(JSON.parse(lines.join("\n")), { endpoint });
  } finally { await runtime.close(); }
});
