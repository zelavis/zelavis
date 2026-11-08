import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { promisify } from "node:util";
import { request as httpsRequest } from "node:https";
import { Effect } from "effect";

import { createRemoteProjectAgent } from "../dist/adapters/_remote-project-agent.js";
import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";
import { makeRemoteKvEngine } from "../dist/db/engines/remote-kv.js";
import { makeRemoteTenantReads } from "../dist/db/engines/remote-reads.js";

const run = promisify(execFile);

/**
 * One TLS Agent for a test file, and a way to make committed shards on it.
 * Shard epochs are kept here per shard id so a test can move the Agent's
 * high-water (`commit`) separately from the epoch an engine's token carries.
 */
export async function startRemoteShardAgent({ shards } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zv-remote-shard-"));
  const keyFile = join(root, "tls.key"), certFile = join(root, "tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  const [keyPem, certPem] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const now = Date.now();
  const keyId = "platform-test";
  const trust = { keys: [{ keyId, publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"), notBefore: new Date(now - 60_000).toISOString(), notAfter: new Date(now + 3_600_000).toISOString() }] };

  let agent;
  let port = 0;
  const start = async () => {
    agent = await createRemoteProjectAgent({ dataDirectory: join(root, "agent"), host: "localhost", port, keyPem, certPem, trust: () => trust, agentId: "agent-b", nodeId: "node-b", ...(shards === undefined ? {} : { shards }) });
    port = Number(new URL(agent.address).port);
    return agent;
  };
  await start();
  const dispatcher = () => createHttpsProjectDispatcher({
    localNodeId: "node-a", projectsDirectory: join(root, "platform"), keyId, privateKey,
    destinations: { "node-b": { url: agent.address, agentId: "agent-b", caPem: certPem } },
  });

  const epochs = new Map();
  const identity = (shardId, { projectId = "p", incarnation = "i" } = {}) => ({ nodeId: "node-b", projectId, incarnation, shardId });
  let counter = 0;
  let closed = false;

  const self = {
    get agent() { return agent; },
    certPem, root, trust, signer: { keyId, privateKey },
    post(path, body) {
      return new Promise((resolve, reject) => {
        const url = new URL(agent.address), payload = JSON.stringify(body);
        const req = httpsRequest({ hostname: url.hostname, port: url.port, path, method: "POST", ca: certPem,
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") }));
        });
        req.on("error", reject);
        req.end(payload);
      });
    },
    /** Delivers preparing, then committed, at `epoch`. */
    async commit(shardId, { epoch = 1, durability = "crash", ...who } = {}) {
      const target = dispatcher();
      await target.deliverAppShardGrant({ ...identity(shardId, who), epoch, state: "preparing", durability });
      await target.deliverAppShardGrant({ ...identity(shardId, who), epoch, state: "committed", durability });
      epochs.set(shardId, epoch);
    },
    async access(shardId, { epoch = epochs.get(shardId) ?? 1, ...who } = {}) {
      const { token, expiresAt } = await dispatcher().authorizeAppShardAccess({ ...identity(shardId, who), epoch });
      return { token, expiresAt };
    },
    /**
     * An engine on `shardId`. Its first token is signed at the shard's epoch when it is first needed; `renew` signs
     * at the fixture's current epoch, or at `renewEpoch` when given (to keep answering a stale one).
     */
    engine(shardId, { renewEpoch, timeoutMillis, ...who } = {}) {
      let held;
      const current = Effect.promise(async () => { held ??= (await self.access(shardId, who)).token; return held; });
      const renew = Effect.promise(async () => {
        held = (await self.access(shardId, { ...who, ...(renewEpoch === undefined ? {} : { epoch: renewEpoch }) })).token;
        return held;
      });
      return makeRemoteKvEngine({
        destination: { url: agent.address, caPem: certPem },
        access: { current, renew },
        ...(timeoutMillis === undefined ? {} : { timeoutMillis }),
      });
    },
    reads(shardId, { renewEpoch, timeoutMillis, ...who } = {}) {
      let held;
      const current = Effect.promise(async () => { held ??= (await self.access(shardId, who)).token; return held; });
      const renew = Effect.promise(async () => {
        held = (await self.access(shardId, { ...who, ...(renewEpoch === undefined ? {} : { epoch: renewEpoch }) })).token;
        return held;
      });
      return makeRemoteTenantReads({ destination: { url: agent.address, caPem: certPem }, access: { current, renew }, shardId,
        ...(timeoutMillis === undefined ? {} : { timeoutMillis }) });
    },
    /** Commits a new shard id and answers an engine on it. */
    freshEngine() {
      const shardId = `r-${counter += 1}`;
      return Effect.flatMap(Effect.promise(() => self.commit(shardId)), () => self.engine(shardId));
    },
    /** Closes the Agent if open and starts it again on the same directory and port, so engines made before keep their address. */
    async restart() {
      if (!closed) await agent.close();
      await start();
      closed = false;
    },
    async closeAgent() {
      if (!closed) { closed = true; await agent.close(); }
    },
    async close() {
      await self.closeAgent();
      await rm(root, { recursive: true, force: true });
    },
  };
  after(() => self.close());
  return self;
}
