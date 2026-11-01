// `zelavis worker join` against a real Platform runtime behind a real HTTPS
// listener: authentication of the Platform before the credential is sent,
// retry after a lost response, and a real Agent started from what it writes.
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect } from "effect";

import { zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { generateAgentCertificate } from "../dist/adapters/_agent-certificate.js";
import { createNodeEnrollmentAuthority } from "../dist/platform/node-enrollment.js";
import { runAgentCommand } from "../dist/cli/agent.js";
import { runWorkerCommand } from "../dist/cli/worker.js";

const OWNER = { id: "owner", type: "user", permissions: ["*"] };

const freePort = () => new Promise((resolve) => {
  const server = createNetServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const exists = (path) => access(path).then(() => true, () => false);
const fingerprintOf = (certPem) => new X509Certificate(certPem).fingerprint256;

/** A Platform runtime and its public HTTPS listener. */
async function platform(t, { remoteDispatch = true } = {}) {
  const data = await mkdtemp(join(tmpdir(), "zelavis-platform-"));
  const adapter = nodeAdapter({
    dataDirectory: data, services: false,
    projects: { directory: join(data, "projects"), ...(remoteDispatch ? { remoteDispatch: { localNodeId: "local", nodes: {} } } : {}) },
  });
  const constructorOptions = {};
  const resolved = await adapter.resolve(constructorOptions);
  const store = resolved.resources.systemStore;
  const runtime = await zelavis({ systemStore: store, resolvePrincipal: () => OWNER });
  const { keyPem, certPem } = generateAgentCertificate({ names: ["127.0.0.1"] });
  const traffic = { requests: 0, dropResponses: 0 };
  const server = createHttpsServer({ key: keyPem, cert: certPem }, (incoming, outgoing) => {
    traffic.requests++;
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", async () => {
      const body = Buffer.concat(chunks);
      const response = await runtime.fetch(new Request(`https://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}),
      }));
      if (traffic.dropResponses > 0) {
        traffic.dropResponses--;
        incoming.socket.destroy(); // the Platform did the work; the caller never hears back
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await adapter.close(constructorOptions);
    await rm(data, { recursive: true, force: true });
  });
  const registry = createNodeEnrollmentAuthority({ store });
  const send = (method, path, body) => runtime.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }));
  const issue = async (nodeId) => (await (await send("POST", "/runtime/nodes/enrollments", { nodeId })).json()).token;
  return {
    url: `https://127.0.0.1:${server.address().port}`, certPem, fingerprint: fingerprintOf(certPem), traffic,
    store, registry, resolved, send, issue,
    enrollment: async (nodeId) => (await Effect.runPromise(registry.enrollments())).find((e) => e.nodeId === nodeId),
    nodes: () => Effect.runPromise(registry.nodes()),
  };
}

/** Run the CLI, returning what it printed. */
async function worker(args) {
  const realLog = console.log;
  const lines = [];
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await runWorkerCommand(args);
  } finally {
    console.log = realLog;
  }
  return lines.join("\n");
}

async function setup(t, options) {
  const subject = await platform(t, options);
  const data = await mkdtemp(join(tmpdir(), "zelavis-worker-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const port = await freePort();
  const join_ = (nodeId, token, extra = []) => worker([
    "join", "--platform-url", subject.url, "--node-id", nodeId, "--enrollment-token", token,
    "--address", "127.0.0.1", "--port", String(port), "--data-dir", data, ...extra,
  ]);
  return { ...subject, data, port, dir: join(data, "worker"), join: join_ };
}

test("join authenticates the Platform by fingerprint, enrolls, and writes a private key and the Agent's configuration", async (t) => {
  const { join, issue, fingerprint, dir, port, nodes, store, data, url } = await setup(t);
  const token = await issue("late");
  const output = await join("late", token, ["--platform-fingerprint", fingerprint]);

  assert.ok(!output.includes(token), "the credential is never echoed");
  assert.match(output, /Joined https:\/\/127\.0\.0\.1:\d+ as late/);
  assert.equal((await stat(join_key(dir))).mode & 0o777, 0o600, "the Agent's private key is readable only by its owner");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const config = JSON.parse(await readFile(`${dir}/remote-project.json`, "utf8"));
  assert.deepEqual(config, { host: "0.0.0.0", port, keyFile: "agent.key", certFile: "agent.crt", trustFile: "trust.json", agentId: "agent-late", nodeId: "late",
    platform: { url: `${url}/zelavis`, fingerprint: fingerprint.replaceAll(":", "").toLowerCase() } });
  const published = (await store.get("fabric.agent-trust.v1", "platform")).value;
  assert.deepEqual(JSON.parse(await readFile(`${dir}/trust.json`, "utf8")), published, "the trust keys the Platform published");

  const [registered] = await nodes();
  assert.equal(registered.nodeId, "late");
  assert.equal(registered.url, `https://127.0.0.1:${port}`);
  assert.equal(registered.certSha256, new X509Certificate(await readFile(`${dir}/agent.crt`, "utf8")).fingerprint256.replaceAll(":", "").toLowerCase(),
    "the Platform pinned the certificate this machine generated");
  assert.ok(!(await readFile(`${dir}/agent.crt`, "utf8")).includes("PRIVATE"), "the key is not in the certificate file");
  assert.ok(data);
});
const join_key = (dir) => `${dir}/agent.key`;

test("a worker started from what join wrote becomes ready in the Platform's inventory", { timeout: 30_000 }, async (t) => {
  const { join, issue, fingerprint, data, dir, resolved } = await setup(t);
  await join("late", await issue("late"), ["--platform-fingerprint", fingerprint]);
  const before = Object.fromEntries((await resolved.subsystems.fabric.inventory.nodes()).map((n) => [n.id, n.status]));
  assert.equal(before.late, "unavailable", "enrolled, but nothing is listening yet");

  const stop = new AbortController();
  const running = runAgentCommand({ dataDirectory: data, remoteProjectConfig: `${dir}/remote-project.json`, signal: stop.signal });
  t.after(async () => { stop.abort(); await running; });
  let status;
  for (let attempt = 0; attempt < 100; attempt++) {
    status = Object.fromEntries((await resolved.subsystems.fabric.inventory.nodes()).map((n) => [n.id, n.status])).late;
    if (status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status, "ready", "the generated certificate and the delivered trust keys are what the Platform's probe needs");
});

test("a Platform that cannot be authenticated never receives the credential", async (t) => {
  const { join, issue, fingerprint, traffic, enrollment, dir } = await setup(t);
  const token = await issue("late");
  const wrong = fingerprint.replace(/^../, (pair) => (pair === "00" ? "01" : "00"));

  await assert.rejects(() => join("late", token, ["--platform-fingerprint", wrong]), /Could not reach the Platform securely.*does not match the pinned fingerprint/s);
  await assert.rejects(() => join("late", token), /Could not reach the Platform securely/, "a self-signed Platform with no pin is refused");
  const strangerCa = await writeCa(t, generateAgentCertificate({ names: ["127.0.0.1"] }).certPem);
  await assert.rejects(() => join("late", token, ["--platform-ca-file", strangerCa]),
    /Could not reach the Platform securely/, "another party's CA does not vouch for it");

  assert.equal(traffic.requests, 0, "no request reached the Platform");
  assert.equal((await enrollment("late")).state, "unused", "the credential is still unspent");
  assert.ok(!(await exists(`${dir}/identity.json`)) && !(await exists(`${dir}/remote-project.json`)));
});

async function writeCa(t, pem) {
  const dir = await mkdtemp(join(tmpdir(), "zelavis-ca-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "ca.pem");
  await writeFile(file, pem);
  return file;
}

test("a CA file the Platform's certificate chains to authenticates it", async (t) => {
  const { join, issue, certPem, nodes } = await setup(t);
  await join("late", await issue("late"), ["--platform-ca-file", await writeCa(t, certPem)]);
  assert.equal((await nodes())[0].nodeId, "late");
});

test("plain http is refused before anything is generated or sent", async (t) => {
  const { data, traffic, issue } = await setup(t);
  const token = await issue("late");
  await assert.rejects(() => worker(["join", "--platform-url", "http://127.0.0.1:1", "--node-id", "late", "--enrollment-token", token, "--address", "127.0.0.1", "--data-dir", data]),
    /must be reached over https/);
  assert.equal(traffic.requests, 0);
  assert.ok(!(await exists(join(data, "worker"))), "not even a directory was created");
});

test("a lost response is recovered by joining again with the same token", async (t) => {
  const { join, issue, fingerprint, traffic, enrollment, nodes, dir } = await setup(t);
  const token = await issue("late");
  traffic.dropResponses = 1;
  await assert.rejects(() => join("late", token, ["--platform-fingerprint", fingerprint]), /Could not reach the Platform securely/);
  assert.equal((await enrollment("late")).state, "consumed", "the Platform did the work");
  assert.ok(!(await exists(`${dir}/identity.json`)), "but this machine does not think it joined");
  assert.ok(await exists(`${dir}/agent.key`), "its identity was kept for the retry");

  const registeredBefore = (await nodes())[0].certSha256;
  await join("late", token, ["--platform-fingerprint", fingerprint]);
  const [after] = await nodes();
  assert.equal(after.certSha256, registeredBefore, "the retry enrolled the same certificate");
  assert.ok(await exists(`${dir}/identity.json`));
});

test("a refused enrollment writes no configuration and says only that it was refused", async (t) => {
  const { join, issue, fingerprint, dir } = await setup(t);
  await issue("late");
  const wrongToken = "A".repeat(43);
  await assert.rejects(() => join("late", wrongToken, ["--platform-fingerprint", fingerprint]), /The Platform refused this enrollment\. Check the node id and token/);
  assert.ok(!(await exists(`${dir}/remote-project.json`)));
  assert.ok(!(await exists(`${dir}/trust.json`)));
});

test("a Platform that does not accept nodes says so", async (t) => {
  const { join, fingerprint } = await setup(t, { remoteDispatch: false });
  await assert.rejects(() => join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]), /does not accept nodes yet/);
});

test("joining again as the same node changes nothing; joining as another node is refused", async (t) => {
  const { join, issue, fingerprint, nodes, dir } = await setup(t);
  await join("late", await issue("late"), ["--platform-fingerprint", fingerprint]);
  const identity = await readFile(`${dir}/identity.json`, "utf8");
  const again = await join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]);
  assert.match(again, /already joined as late/);
  assert.equal(await readFile(`${dir}/identity.json`, "utf8"), identity);
  const otherToken = await issue("other");
  await assert.rejects(() => join("other", otherToken, ["--platform-fingerprint", fingerprint]), /already joined as late/);
  assert.equal((await nodes()).length, 1);
});

test("a key file left readable by others is refused rather than reused", async (t) => {
  const { join, issue, fingerprint, dir } = await setup(t);
  const token = await issue("late");
  await assert.rejects(() => join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]), /refused this enrollment/);
  await chmod(`${dir}/agent.key`, 0o644);
  await assert.rejects(() => join("late", token, ["--platform-fingerprint", fingerprint]), /readable only by its owner/);
});

test("half of an earlier attempt, or a certificate for other addresses, is refused with a way out", async (t) => {
  const { join, issue, fingerprint, dir, data, port } = await setup(t);
  await assert.rejects(() => join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]), /refused/);
  await rm(`${dir}/agent.crt`);
  await assert.rejects(() => join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]), /only part of an earlier attempt/);
  await rm(`${dir}/agent.key`);
  await assert.rejects(() => join("late", "A".repeat(43), ["--platform-fingerprint", fingerprint]), /refused/);
  const fresh = await issue("late");
  await assert.rejects(() => worker(["join", "--platform-url", "https://127.0.0.1:1", "--node-id", "late", "--enrollment-token", fresh,
    "--address", "10.9.8.7", "--port", String(port), "--data-dir", data, "--platform-fingerprint", fingerprint]), /different addresses/);
});

test("the CLI refuses bad usage before doing anything", async () => {
  const base = ["join", "--platform-url", "https://127.0.0.1:1", "--node-id", "n", "--enrollment-token", "t", "--address", "127.0.0.1"];
  const cases = [
    [[], null],
    [["join"], /--platform-url is required/],
    [["join", "--platform-url", "https://x"], /--node-id is required/],
    [["join", "--platform-url", "https://x", "--node-id", "n"], /--enrollment-token is required/],
    [[...base, "--platform-fingerprint", "nonsense"], /SHA-256 of 64 hex digits/],
    [[...base, "--platform-fingerprint", "sha256:" + "a".repeat(64), "--platform-ca-file", "/x"], /not both/],
    [[...base, "--port", "0"], /port number/],
    [[...base, "--port", "70000"], /port number/],
    [[...base, "--bogus", "1"], /Unknown worker option/],
    [[...base, "--platform-url", "https://a", "--platform-url", "https://b"], /only once/],
    [["join", "--platform-url", "https://user:pw@x", "--node-id", "n", "--enrollment-token", "t"], /nothing else/],
    [["frobnicate"], /Unknown worker command/],
  ];
  for (const [args, pattern] of cases) {
    if (pattern === null) { assert.match(await worker(args), /zelavis worker join/); continue; }
    await assert.rejects(() => worker(args), pattern, JSON.stringify(args).slice(0, 80));
  }
});

test("the JSON output carries the identity and how to start the Agent, and never a secret", async (t) => {
  const { join, issue, fingerprint, dir } = await setup(t);
  const token = await issue("late");
  const output = JSON.parse(await join("late", token, ["--platform-fingerprint", fingerprint, "--json"]));
  assert.equal(output.joined, true);
  assert.equal(output.nodeId, "late");
  assert.match(output.start, /zelavis agent --data-dir .* --remote-project-config /);
  assert.ok(!JSON.stringify(output).includes(token));
  assert.ok(!JSON.stringify(output).includes("PRIVATE KEY"));
  assert.ok(!(await readFile(`${dir}/identity.json`, "utf8")).includes("PRIVATE"));
});

const rotatedKeys = (validFrom, validTo) => ({ keys: [
  ...[0, 1].map((n) => ({ keyId: `platform-${n}`, publicKey: Buffer.alloc(32, n + 1).toString("base64"), notBefore: validFrom, notAfter: validTo })),
] });
const NOW_ISO = () => new Date().toISOString();
const DAY = 86_400_000;
const later = (days) => new Date(Date.now() + days * DAY).toISOString();
const earlier = (days) => new Date(Date.now() - days * DAY).toISOString();

test("refresh-trust follows a key rotation over the pinned connection, and says when nothing changed", async (t) => {
  const { join, issue, fingerprint, dir, store, data } = await setup(t);
  await join("late", await issue("late"), ["--platform-fingerprint", fingerprint]);
  const before = JSON.parse(await readFile(`${dir}/trust.json`, "utf8"));

  assert.match(await worker(["refresh-trust", "--data-dir", data]), /unchanged/);

  const rotated = { keys: [...before.keys, ...rotatedKeys(earlier(1), later(365)).keys] };
  await store.set("fabric.agent-trust.v1", "platform", rotated);
  assert.match(await worker(["refresh-trust", "--data-dir", data]), /Updated the Platform's keys \(3\)/);
  assert.deepEqual(JSON.parse(await readFile(`${dir}/trust.json`, "utf8")), rotated);
  assert.match(await worker(["refresh-trust", "--data-dir", data]), /unchanged/);
  assert.deepEqual(JSON.parse(await worker(["refresh-trust", "--data-dir", data, "--json"])), { changed: false, keys: rotated.keys.map((key) => key.keyId) });
});

test("refresh-trust never replaces the keys with ones that trust nothing, or with an answer from the wrong Platform", async (t) => {
  const { join, issue, fingerprint, dir, store, data } = await setup(t);
  await join("late", await issue("late"), ["--platform-fingerprint", fingerprint]);
  const before = await readFile(`${dir}/trust.json`, "utf8");

  await store.set("fabric.agent-trust.v1", "platform", rotatedKeys(earlier(400), earlier(35)));
  await assert.rejects(worker(["refresh-trust", "--data-dir", data]), /no key that is valid now/);
  assert.equal(await readFile(`${dir}/trust.json`, "utf8"), before);

  await store.set("fabric.agent-trust.v1", "platform", { keys: [{ keyId: "x", publicKey: "k", notBefore: "nope", notAfter: NOW_ISO() }] });
  await assert.rejects(worker(["refresh-trust", "--data-dir", data]), /not valid/);

  const config = JSON.parse(await readFile(`${dir}/remote-project.json`, "utf8"));
  config.platform.fingerprint = "ab".repeat(32);
  await writeFile(`${dir}/remote-project.json`, JSON.stringify(config));
  await assert.rejects(worker(["refresh-trust", "--data-dir", data]), /Could not refresh/);
  assert.equal(await readFile(`${dir}/trust.json`, "utf8"), before, "a pin that does not match changes nothing");
});

test("refresh-trust on a machine that never joined says so", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "zelavis-worker-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await assert.rejects(worker(["refresh-trust", "--data-dir", data]), /has not joined/);
});

test("a worker whose stored keys went stale refreshes them at start and is ready without a restart", { timeout: 30_000 }, async (t) => {
  const { join, issue, fingerprint, data, dir, resolved } = await setup(t);
  await join("late", await issue("late"), ["--platform-fingerprint", fingerprint]);
  const current = await readFile(`${dir}/trust.json`, "utf8");
  await writeFile(`${dir}/trust.json`, JSON.stringify(rotatedKeys(earlier(400), later(10))));

  const stop = new AbortController();
  const running = runAgentCommand({ dataDirectory: data, remoteProjectConfig: `${dir}/remote-project.json`, signal: stop.signal });
  t.after(async () => { stop.abort(); await running; });
  let status;
  for (let attempt = 0; attempt < 150; attempt++) {
    status = Object.fromEntries((await resolved.subsystems.fabric.inventory.nodes()).map((n) => [n.id, n.status])).late;
    if (status === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status, "ready", "the Agent asked the Platform for its keys and verified with them");
  assert.equal(await readFile(`${dir}/trust.json`, "utf8"), current, "and wrote them for the next start");
});
