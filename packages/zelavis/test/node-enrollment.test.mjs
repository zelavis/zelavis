import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import { Cause, Effect, Exit } from "effect";

import {
  ENROLLMENT_TTL_MS,
  NODE_ENROLLMENT_NAMESPACE,
  NODE_REGISTRY_NAMESPACE,
  agentIdFor,
  createNodeEnrollmentAuthority,
} from "../dist/platform/node-enrollment.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const run = promisify(execFile);
const MINUTE = 60_000;
const URL_A = "https://203.0.113.10:8443";
let certA;
let certB;

async function makeCertificate(directory, name) {
  const keyFile = join(directory, `${name}.key`);
  const certFile = join(directory, `${name}.crt`);
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", `/CN=${name}`]);
  return readFile(certFile, "utf8");
}

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-enroll-"));
  certA = await makeCertificate(directory, "agent-a");
  certB = await makeCertificate(directory, "agent-b");
});

function setup({ store = createMemorySystemStore(), start = 1_000_000 } = {}) {
  const clock = { now: start };
  const authority = createNodeEnrollmentAuthority({ store, now: () => clock.now });
  return { store, clock, authority };
}

const go = (effect) => Effect.runPromise(effect);
/** The typed failure of an Effect, or a test failure if it succeeded. */
async function failure(effect) {
  const exit = await Effect.runPromiseExit(effect);
  assert.ok(Exit.isFailure(exit), "expected a failure");
  return Cause.squash(exit.cause);
}
const mintCloud = (authority, nodeId = "node-a", extra = {}) =>
  go(authority.mint({ nodeId, origin: "cloud", ...extra }));
const enroll = (authority, minted, extra = {}) =>
  go(authority.complete({ nodeId: minted.nodeId, token: minted.token, certPem: certA, url: URL_A, ...extra }));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("mint returns a single-use token once and stores only its hash", async () => {
  const { authority, store, clock } = setup();
  const minted = await mintCloud(authority);
  assert.match(minted.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.expiresAt, clock.now + ENROLLMENT_TTL_MS.cloud);
  const stored = (await store.get(NODE_ENROLLMENT_NAMESPACE, "node-a")).value;
  assert.equal(stored.tokenHash, sha256(minted.token));
  assert.ok(!JSON.stringify(stored).includes(minted.token), "the plaintext token is never stored");
  assert.equal(stored.state, "unused");
});

test("operator-issued enrollments last longer than cloud ones, within bounds", async () => {
  const { authority, clock } = setup();
  assert.equal((await go(authority.mint({ nodeId: "own-server", origin: "operator" }))).expiresAt, clock.now + 60 * MINUTE);
  for (const ttlMs of [10_000, 25 * 60 * MINUTE, 1.5]) {
    assert.equal((await failure(authority.mint({ nodeId: "n", origin: "cloud", ttlMs }))).code, "invalid-request", String(ttlMs));
  }
  assert.equal((await failure(authority.mint({ nodeId: "n", origin: "root" }))).code, "invalid-request");
});

test("node ids must be hostname labels", async () => {
  const { authority } = setup();
  for (const nodeId of ["", "Node-A", "-a", "a-", "a/b", "a".repeat(64), "a b"]) {
    assert.equal((await failure(authority.mint({ nodeId, origin: "cloud" }))).code, "invalid-request", nodeId);
  }
});

test("enrolling registers the node with the Agent's pinned certificate", async () => {
  const { authority, store } = setup();
  const minted = await mintCloud(authority);
  const { node, resumed } = await enroll(authority, minted, { url: "https://203.0.113.10:8443" });
  assert.equal(resumed, false);
  assert.equal(node.nodeId, "node-a");
  assert.equal(node.agentId, agentIdFor("node-a"));
  assert.equal(node.url, URL_A);
  assert.equal(node.caPem.trim(), certA.trim());
  assert.equal(node.certSha256, new X509Certificate(certA).fingerprint256.replaceAll(":", "").toLowerCase(),
    "agrees with Node's own certificate fingerprint");
  assert.equal((await store.get(NODE_ENROLLMENT_NAMESPACE, "node-a")).value.state, "consumed");
  assert.deepEqual(await go(authority.destinations()), {
    "node-a": { url: URL_A, caPem: node.caPem, agentId: "agent-node-a" },
  });
});

test("a token is single-use: another certificate cannot replay it", async () => {
  const { authority, store } = setup();
  const minted = await mintCloud(authority);
  await enroll(authority, minted);
  const error = await failure(authority.complete({ nodeId: "node-a", token: minted.token, certPem: certB, url: URL_A }));
  assert.equal(error.code, "refused");
  assert.equal(error.reason, "already-consumed");
  assert.equal((await store.get(NODE_REGISTRY_NAMESPACE, "node-a")).value.certSha256,
    new X509Certificate(certA).fingerprint256.replaceAll(":", "").toLowerCase(), "the registered identity is unchanged");
});

test("the same certificate may finish an enrollment, so a crash after consume is recoverable", async () => {
  const store = createMemorySystemStore();
  const crashing = Object.create(store);
  let crash = 1;
  crashing.setIfAbsent = (namespace, key, value) => {
    if (namespace === NODE_REGISTRY_NAMESPACE && crash-- > 0) throw new Error("injected crash after consume");
    return store.setIfAbsent(namespace, key, value);
  };
  const { authority } = setup({ store: crashing });
  const minted = await mintCloud(authority);
  await assert.rejects(() => enroll(authority, minted), /injected crash/);
  assert.equal((await store.get(NODE_ENROLLMENT_NAMESPACE, "node-a")).value.state, "consumed");
  assert.equal(await store.get(NODE_REGISTRY_NAMESPACE, "node-a"), undefined, "registration did not happen");
  const resumed = await enroll(authority, minted);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.node.nodeId, "node-a");
  assert.equal((await go(authority.nodes())).length, 1);
});

test("a wrong token is refused and does not consume the real one", async () => {
  const { authority } = setup();
  const minted = await mintCloud(authority);
  const forged = `${minted.token.slice(0, -1)}${minted.token.endsWith("A") ? "B" : "A"}`;
  const error = await failure(authority.complete({ nodeId: "node-a", token: forged, certPem: certA, url: URL_A }));
  assert.equal(error.reason, "bad-token");
  assert.equal((await enroll(authority, minted)).resumed, false, "the real token still works");
});

test("an unknown node and a wrong token are indistinguishable to the caller", async () => {
  const { authority } = setup();
  const minted = await mintCloud(authority);
  const token = "A".repeat(43);
  const unknown = await failure(authority.complete({ nodeId: "other", token, certPem: certA, url: URL_A }));
  const wrong = await failure(authority.complete({ nodeId: minted.nodeId, token, certPem: certA, url: URL_A }));
  assert.equal(unknown.code, "refused");
  assert.equal(unknown.message, wrong.message);
  assert.deepEqual([unknown.reason, wrong.reason], ["unknown-node", "bad-token"], "the reason is kept for audit");
});

test("an expired token is refused, including for a resumed enrollment", async () => {
  const { authority, clock } = setup();
  const minted = await mintCloud(authority);
  clock.now += ENROLLMENT_TTL_MS.cloud + 1;
  assert.equal((await failure(authority.complete({ nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A }))).reason, "expired");

  const second = await mintCloud(authority, "node-b");
  await enroll(authority, second);
  clock.now += ENROLLMENT_TTL_MS.cloud + 1;
  assert.equal((await failure(authority.complete({ nodeId: "node-b", token: second.token, certPem: certA, url: URL_A }))).reason, "expired");
});

test("a source address mismatch is refused; an unknown source is allowed", async () => {
  const { authority } = setup();
  const minted = await mintCloud(authority, "node-a", { expectedAddress: "203.0.113.10" });
  assert.equal((await failure(authority.complete({
    nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A, sourceAddress: "198.51.100.7",
  }))).reason, "source-mismatch");
  assert.equal((await enroll(authority, minted, { sourceAddress: "203.0.113.10" })).node.nodeId, "node-a");
  const other = await mintCloud(authority, "node-b", { expectedAddress: "203.0.113.11" });
  assert.equal((await enroll(authority, other)).node.nodeId, "node-b", "no source given (not a direct connection)");
});

test("two machines racing for one token: exactly one wins", async () => {
  const { authority } = setup();
  const minted = await mintCloud(authority);
  const results = await Promise.all([certA, certB].map((certPem) =>
    Effect.runPromiseExit(authority.complete({ nodeId: "node-a", token: minted.token, certPem, url: URL_A }))));
  assert.equal(results.filter(Exit.isSuccess).length, 1);
  assert.equal(results.filter(Exit.isFailure).length, 1);
  const nodes = await go(authority.nodes());
  assert.equal(nodes.length, 1);
  const winner = results.findIndex(Exit.isSuccess) === 0 ? certA : certB;
  assert.equal(nodes[0].caPem.trim(), winner.trim());
});

test("malformed input is rejected before the token is consumed", async () => {
  const { authority, store } = setup();
  const minted = await mintCloud(authority);
  const bad = [
    { token: "short" },
    { url: "http://203.0.113.10:8443" },
    { url: "https://user:pw@203.0.113.10:8443" },
    { url: "https://203.0.113.10:8443/path" },
    { url: "https://203.0.113.10:8443/?q=1" },
    { url: "not a url" },
    { certPem: "garbage" },
    { certPem: `${certA}${certB}` },
    { certPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----" },
    { certPem: certA + "x".repeat(9000) },
  ];
  for (const override of bad) {
    const error = await failure(authority.complete({ nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A, ...override }));
    assert.equal(error.code, "invalid-request", JSON.stringify(override).slice(0, 60));
  }
  assert.equal((await store.get(NODE_ENROLLMENT_NAMESPACE, "node-a")).value.state, "unused");
});

test("a pending enrollment is not silently replaced, and an unused one can be on request", async () => {
  const { authority, clock } = setup();
  const first = await mintCloud(authority);
  assert.equal((await failure(authority.mint({ nodeId: "node-a", origin: "cloud" }))).code, "enrollment-pending");
  const second = await mintCloud(authority, "node-a", { replace: true });
  assert.notEqual(first.token, second.token);
  assert.equal((await failure(authority.complete({ nodeId: "node-a", token: first.token, certPem: certA, url: URL_A }))).reason, "bad-token",
    "the replaced token no longer works");
  assert.equal((await enroll(authority, second)).node.nodeId, "node-a");

  const expired = await mintCloud(authority, "node-b");
  clock.now += ENROLLMENT_TTL_MS.cloud + 1;
  assert.ok(await mintCloud(authority, "node-b"), "an expired unused enrollment is replaceable without asking");
  assert.ok(expired);
});

test("a node that already enrolled cannot be minted again", async () => {
  const { authority } = setup();
  await enroll(authority, await mintCloud(authority));
  assert.equal((await failure(authority.mint({ nodeId: "node-a", origin: "cloud", replace: true }))).code, "node-exists");
});

test("revoking leaves a tombstone: no destination, no reuse of the id", async () => {
  const { authority } = setup();
  await enroll(authority, await mintCloud(authority));
  const revoked = await go(authority.revoke("node-a"));
  assert.equal(revoked.state, "revoked");
  assert.deepEqual(await go(authority.destinations()), {});
  assert.equal((await go(authority.nodes()))[0].state, "revoked");
  assert.equal((await go(authority.revoke("node-a"))).state, "revoked", "idempotent");
  assert.equal((await failure(authority.mint({ nodeId: "node-a", origin: "cloud" }))).code, "node-exists");
  assert.equal((await failure(authority.revoke("missing"))).code, "refused");
});

test("nodes lists every node in a stable order", async () => {
  const { authority } = setup();
  for (const id of ["node-c", "node-a", "node-b"]) await enroll(authority, await mintCloud(authority, id));
  assert.deepEqual((await go(authority.nodes())).map((node) => node.nodeId), ["node-a", "node-b", "node-c"]);
});

test("prune removes only expired unused enrollments, a bounded page at a time", async () => {
  const { authority, clock, store } = setup();
  await mintCloud(authority, "expired-1");
  await mintCloud(authority, "expired-2");
  clock.now += ENROLLMENT_TTL_MS.cloud + 1;
  await mintCloud(authority, "live");
  await enroll(authority, await mintCloud(authority, "enrolled"));
  clock.now += 1;
  assert.equal(await go(authority.prune(1)), 1, "bounded by the page size");
  assert.equal(await go(authority.prune(100)), 1);
  assert.equal(await store.get(NODE_ENROLLMENT_NAMESPACE, "expired-1"), undefined);
  assert.ok(await store.get(NODE_ENROLLMENT_NAMESPACE, "live"));
  assert.ok(await store.get(NODE_ENROLLMENT_NAMESPACE, "enrolled"), "a consumed record is kept");
});

test("persistent write conflicts are retried a bounded number of times, then reported", async () => {
  const store = createMemorySystemStore();
  const { authority } = setup({ store });
  const minted = await mintCloud(authority);
  const losing = Object.create(store);
  let attempts = 0;
  losing.compareAndSet = () => {
    attempts++;
    return undefined;
  };
  const contended = createNodeEnrollmentAuthority({ store: losing, now: () => 1_000_000 });
  const error = await failure(contended.complete({ nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A }));
  assert.equal(error.code, "contention");
  assert.equal(attempts, 8);
});

test("a malformed stored record is reported, never trusted", async () => {
  const { authority, store } = setup();
  await store.set(NODE_ENROLLMENT_NAMESPACE, "node-a", { v: 1, nonsense: true });
  assert.equal((await failure(authority.complete({ nodeId: "node-a", token: "A".repeat(43), certPem: certA, url: URL_A }))).code, "invalid-request");
});

test("destination returns one active node, and nothing for unknown, malformed or revoked ids", async () => {
  const { authority } = setup();
  const { node } = await enroll(authority, await mintCloud(authority));
  assert.deepEqual(await go(authority.destination("node-a")), { url: URL_A, caPem: node.caPem, agentId: "agent-node-a" });
  for (const nodeId of ["missing", "", "Not A Node", "../x"]) {
    assert.equal(await go(authority.destination(nodeId)), undefined, nodeId);
  }
  await go(authority.revoke("node-a"));
  assert.equal(await go(authority.destination("node-a")), undefined);
});

test("a worker newer than the Platform is refused without spending its token; equal and older are accepted and flagged", async () => {
  const { nodeCompatibility } = await import("../dist/platform/node-enrollment.js");
  const store = createMemorySystemStore();
  const authority = createNodeEnrollmentAuthority({ store, now: () => 1_000_000, platformVersion: "1.2.0" });
  const minted = await go(authority.mint({ nodeId: "node-a", origin: "cloud" }));
  const complete = (version, token = minted.token) => go(authority.complete({ nodeId: "node-a", token, certPem: certA, url: URL_A, version }));

  const newer = await failure(authority.complete({ nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A, version: "1.3.0" }));
  assert.equal(newer.code, "worker-newer");
  assert.match(newer.message, /1\.3\.0.*1\.2\.0/);
  const wrongToken = await failure(authority.complete({ nodeId: "node-a", token: "A".repeat(43), certPem: certA, url: URL_A, version: "1.3.0" }));
  assert.equal(wrongToken.code, "refused", "a caller without the token learns nothing about versions");

  const joined = await complete("1.1.9");
  assert.equal(joined.node.version, "1.1.9", "the token was not spent by the refusal");
  assert.equal(nodeCompatibility("1.2.0", "1.1.9"), "behind");
  assert.equal(nodeCompatibility("1.2.0", "1.2.0"), "current");
  assert.equal(nodeCompatibility("1.2.0", undefined), "unknown");
  assert.equal(nodeCompatibility("1.2.0-alpha.3", "1.2.0-alpha.2"), "behind");
  assert.equal((await failure(authority.complete({ nodeId: "node-a", token: minted.token, certPem: certA, url: URL_A, version: "not-a-version" }))).code, "invalid-request");
});
