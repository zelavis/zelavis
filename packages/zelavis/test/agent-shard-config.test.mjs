import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { readAgentShardOptions, runAgentCommand } from "../dist/cli/agent.js";

const run = promisify(execFile);

test("an Agent's config reads its shard bounds, every one a non-negative integer, and nothing else", () => {
  assert.deepEqual(readAgentShardOptions({ readsPerShard: 2, readsPerAgent: 8, readPermitWaitMillis: 500, readDeadlineMillis: 5000, maxReadAnswerBytes: 1024,
    readLimits: { bytes: 1024, entries: 10, postings: 20 } }),
  { readsPerShard: 2, readsPerAgent: 8, readPermitWaitMillis: 500, readDeadlineMillis: 5000, maxReadAnswerBytes: 1024, readLimits: { bytes: 1024, entries: 10, postings: 20 } });
  assert.deepEqual(readAgentShardOptions({}), {});
  assert.deepEqual(readAgentShardOptions({ readLimits: { entries: 0 } }), { readLimits: { entries: 0 } });
  for (const [value, message] of [
    [null, /shards must be an object/], [[], /shards must be an object/], [{ readsPerShard: -1 }, /shards\.readsPerShard must be a non-negative safe integer/],
    [{ readDeadlineMillis: 1.5 }, /readDeadlineMillis/], [{ maxReadAnswerBytes: "9" }, /maxReadAnswerBytes/], [{ readsPerAgent: Infinity }, /readsPerAgent/],
    [{ reads: 1 }, /no key reads/], [{ readLimits: 5 }, /readLimits must be an object/], [{ readLimits: { entries: -1 } }, /readLimits\.entries/],
    [{ readLimits: { rows: 1 } }, /readLimits has no key rows/],
  ]) assert.throws(() => readAgentShardOptions(value), message, JSON.stringify(value));
});

test("an Agent started from a config file serves reads under the limits the file sets", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zv-agent-shard-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "tls.key"), "-out", join(root, "tls.crt"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const certPem = await readFile(join(root, "tls.crt"), "utf8");
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now(), keyId = "platform-test";
  const trust = { keys: [{ keyId, publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() }] };
  await writeFile(join(root, "trust.json"), JSON.stringify(trust));
  const port = await new Promise((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const config = (shards) => JSON.stringify({ host: "localhost", port, keyFile: "tls.key", certFile: "tls.crt", trustFile: "trust.json", agentId: "agent-b", nodeId: "node-b", shards });
  await writeFile(join(root, "bad.json"), config({ readLimits: { entries: -1 } }));
  await assert.rejects(runAgentCommand({ dataDirectory: join(root, "bad"), remoteProjectConfig: join(root, "bad.json") }), /readLimits\.entries must be a non-negative safe integer/);

  await writeFile(join(root, "remote-project.json"), config({ readLimits: { entries: 0 } }));
  const stop = new AbortController();
  const running = runAgentCommand({ dataDirectory: join(root, "agent"), remoteProjectConfig: join(root, "remote-project.json"), signal: stop.signal });
  t.after(async () => { stop.abort(); await running; });
  const url = `https://localhost:${port}`;
  const dispatcher = createHttpsProjectDispatcher({ localNodeId: "node-a", projectsDirectory: join(root, "platform"), keyId, privateKey,
    destinations: { "node-b": { url, agentId: "agent-b", caPem: certPem } } });
  const who = { nodeId: "node-b", projectId: "p", incarnation: "i", shardId: "c1", epoch: 1 };
  // The Agent is ready once it accepts a grant.
  for (let attempt = 0; ; attempt++) {
    try { await dispatcher.deliverAppShardGrant({ ...who, state: "preparing", durability: "crash" }); break; }
    catch (error) { if (attempt > 100) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  await dispatcher.deliverAppShardGrant({ ...who, state: "committed", durability: "crash" });
  const { token } = await dispatcher.authorizeAppShardAccess(who);
  const body = JSON.stringify({ protocol: 1, access: token, partition: "t", routedBy: 1, op: "documents.listCollections", input: null });
  const answer = await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: "localhost", port, path: "/v1/shards/reads", method: "POST", ca: certPem,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(body);
  });
  assert.deepEqual(answer, { status: 200, body: { defect: { _tag: "ReadBudgetExceeded", limit: "entries", max: 0 } } });
});
