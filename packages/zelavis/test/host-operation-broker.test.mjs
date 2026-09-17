import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createHostOperationBroker,
  createMemorySystemStore,
  hostOperationArgumentsDigest,
  verifyAgentAuthority,
  zelavis,
  ZelavisHostOperationForbiddenError,
  ZelavisHostOperationNotFoundError,
} from "../dist/index.js";
import { readOrCreatePlatformAuthorityKey } from "../dist/adapters/_platform-authority-key.js";
import { createAgentProcessClient } from "../dist/adapters/_agent-ipc.js";
import { runAgentCommand } from "../dist/cli/agent.js";
import { runCli } from "../dist/cli/commands.js";
import { createZelavisClient, ZelavisClientHttpError } from "../dist/sdk/fetch.js";
import { createReleaseSigner } from "./fixtures/host-operation-signing.mjs";

const sha = (body) => createHash("sha256").update(body).digest("hex");
const DIGEST = "c".repeat(64);
const MANIFESTS = [
  { id: "native.site-reload", version: "v1", sha256: DIGEST, arguments: { site: { required: true, pattern: "^[a-z-]+$" } },
    authorization: { permission: "project.hosting.reload", scope: "project" } },
  { id: "native.host-report", version: "v1", sha256: DIGEST, arguments: {},
    authorization: { permission: "server.hosting.report", scope: "system" } },
  // Installed but never requestable: no signed authorization policy.
  { id: "native.unlisted", version: "v1", sha256: DIGEST, arguments: {} },
];

function fakeAgent() {
  const submitted = [];
  return {
    submitted,
    agent: {
      async hostOperationCatalog() { return { agentId: "agent-1", operations: MANIFESTS }; },
      async submitHostOperation(request) {
        submitted.push(request);
        return { operationId: request.operationId, agentId: "agent-1", operation: request.operation, version: request.version,
          artifactDigest: request.artifactDigest, status: "queued", attempts: 0, createdAt: "", updatedAt: "", events: [],
          ...(request.projectId ? { projectId: request.projectId } : {}) };
      },
      async getHostOperation(operationId) {
        const request = submitted.find((entry) => entry.operationId === operationId);
        return request ? { operationId, agentId: "agent-1", operation: request.operation, version: request.version,
          artifactDigest: request.artifactDigest, status: "succeeded", attempts: 1, createdAt: "", updatedAt: "", events: [] } : undefined;
      },
    },
  };
}

const user = (id, extra = {}) => ({ id, type: "user", ...extra });

async function brokerWith() {
  const platform = await createReleaseSigner({ keyId: "platform-unit" });
  const store = createMemorySystemStore();
  const { agent, submitted } = fakeAgent();
  const broker = createHostOperationBroker({ agent, store, signer: { keyId: "platform-unit", privateKey: platform.privateKey } });
  return { broker, store, submitted, platform };
}

test("authority is issued only for the permission and scope the signed manifest names", async () => {
  const { broker, store, submitted, platform } = await brokerWith();
  const projectOperator = user("alice", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-a" } }] });

  const record = await broker.submit({ operation: "native.site-reload", projectId: "site-a", arguments: { site: "blog" } }, projectOperator);
  assert.match(record.operationId, /^hostop_[a-f0-9]{32}$/);
  assert.equal(record.agent.status, "queued");
  assert.equal(submitted.length, 1);

  // The envelope the Agent receives verifies against the Platform key and is
  // bound to this actor, Project and argument set.
  const claims = await verifyAgentAuthority(platform.trust, submitted[0].authority, submitted[0], { audienceAgentId: "agent-1" });
  assert.equal(claims.actorId, "alice");
  assert.equal(claims.projectId, "site-a");
  assert.equal(claims.argumentsDigest, await hostOperationArgumentsDigest({ site: "blog" }));
  assert.ok(claims.expiresAt - claims.issuedAt <= 60_000);

  // Audit written, without argument values.
  const audit = (await store.get("host-operation-audit", record.operationId)).value;
  assert.deepEqual(audit.argumentNames, ["site"]);
  assert.equal(JSON.stringify(audit).includes("blog"), false);

  const refusals = [
    [{ operation: "native.site-reload", projectId: "site-b", arguments: { site: "blog" } }, projectOperator, ZelavisHostOperationForbiddenError],
    [{ operation: "native.site-reload", arguments: { site: "blog" } }, projectOperator, /requires a projectId/],
    [{ operation: "native.host-report", projectId: "site-a" }, user("root", { permissions: ["*"] }), /does not accept a projectId/],
    [{ operation: "native.host-report" }, projectOperator, ZelavisHostOperationForbiddenError],
    [{ operation: "native.unlisted" }, user("root", { permissions: ["*"] }), ZelavisHostOperationNotFoundError],
    [{ operation: "native.missing" }, user("root", { permissions: ["*"] }), ZelavisHostOperationNotFoundError],
    [{ operation: "native.site-reload", projectId: "site-a", arguments: { site: "Bad Name" } }, projectOperator, /invalid value/],
    [{ operation: "native.site-reload", projectId: "site-a", arguments: { site: "blog", extra: "x" } }, projectOperator, /undeclared argument/],
    [{ operation: "native.site-reload", projectId: "site-a", arguments: { site: "blog" }, deadlineMs: 16 * 60_000 }, projectOperator, /deadlineMs/],
    [{ operation: "native.host-report" }, undefined, /Authentication required/],
    [{ operation: "native.host-report" }, { id: "anon", type: "anonymous" }, /Authentication required/],
  ];
  for (const [input, principal, expected] of refusals) {
    await assert.rejects(broker.submit(input, principal), expected, JSON.stringify(input));
  }
  // Nothing refused reached the Agent or the audit log.
  assert.equal(submitted.length, 1);
  assert.equal((await store.list("host-operation-audit")).length, 1);

  // A top-level permission spans Projects.
  const admin = user("bob", { permissions: ["project.hosting.reload", "server.hosting.report"] });
  await broker.submit({ operation: "native.site-reload", projectId: "site-z", arguments: { site: "shop" } }, admin);
  await broker.submit({ operation: "native.host-report" }, admin);
  assert.equal(submitted.length, 3);
});

test("catalog and status disclose only what the caller could request", async () => {
  const { broker } = await brokerWith();
  const alice = user("alice", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-a" } }] });
  assert.deepEqual((await broker.catalog(alice)).map((entry) => entry.operation), ["native.site-reload"]);
  assert.deepEqual((await broker.catalog(user("root", { permissions: ["*"] }))).map((entry) => entry.operation),
    ["native.site-reload", "native.host-report"]);
  assert.deepEqual(await broker.catalog(user("nobody")), []);

  const record = await broker.submit({ operation: "native.site-reload", projectId: "site-a", arguments: { site: "blog" } }, alice);
  assert.equal((await broker.get(record.operationId, alice)).agent.status, "succeeded");
  // Another operator of the same Project may read it; one of another Project
  // gets the same answer as for an operation that does not exist.
  const sameProject = user("carol", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-a" } }] });
  assert.equal((await broker.get(record.operationId, sameProject)).actorId, "alice");
  const otherProject = user("dave", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-b" } }] });
  await assert.rejects(broker.get(record.operationId, otherProject), ZelavisHostOperationNotFoundError);
  await assert.rejects(broker.get("hostop_" + "0".repeat(32), alice), ZelavisHostOperationNotFoundError);
  await assert.rejects(broker.get("../escape", alice), ZelavisHostOperationNotFoundError);
});

test("the Platform authority key is private, published as a trust file, and rotated with overlap", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-platform-authority-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const first = await readOrCreatePlatformAuthorityKey(join(directory, "authority"), now);
  assert.equal((await lstat(join(directory, "authority", "signing-keys.json"))).mode & 0o777, 0o600);
  assert.equal((await lstat(first.trustFile)).mode & 0o777, 0o644);
  const published = JSON.parse(await readFile(first.trustFile, "utf8"));
  assert.deepEqual(published.keys.map((key) => key.keyId), [first.signer.keyId]);
  assert.equal(JSON.stringify(published).includes("privateKey"), false);

  // Same key on restart.
  assert.equal((await readOrCreatePlatformAuthorityKey(join(directory, "authority"), now + 1_000)).signer.keyId, first.signer.keyId);
  // 20 days before expiry a new key signs; the old one stays trusted.
  const rotated = await readOrCreatePlatformAuthorityKey(join(directory, "authority"), now + 345 * 86_400_000);
  assert.notEqual(rotated.signer.keyId, first.signer.keyId);
  assert.deepEqual(rotated.trust.keys.map((key) => key.keyId), [first.signer.keyId, rotated.signer.keyId]);
  // After the old key expires it is dropped.
  const later = await readOrCreatePlatformAuthorityKey(join(directory, "authority"), now + 370 * 86_400_000);
  assert.deepEqual(later.trust.keys.map((key) => key.keyId), [rotated.signer.keyId]);
});

async function cli(fetcher, args) {
  const originals = [globalThis.fetch, console.log, console.error, process.exitCode];
  const out = [];
  const err = [];
  globalThis.fetch = fetcher;
  console.log = (value) => out.push(value);
  console.error = (value) => err.push(value);
  process.exitCode = undefined;
  try {
    await runCli(["host-operations", ...args, "--url", "http://localhost/zelavis", "--json"]);
    return { exitCode: process.exitCode ?? 0, stdout: out.length ? JSON.parse(out.join("\n")) : undefined, stderr: err.length ? JSON.parse(err.join("\n")) : undefined };
  } finally {
    [globalThis.fetch, console.log, console.error] = originals;
    process.exitCode = originals[3];
  }
}

test("catalog, submit and status are equivalent over HTTP, SDK and CLI", async (t) => {
  const { broker, submitted } = await brokerWith();
  const operator = { principal: user("alice", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-a" } }] }) };
  const zv = await zelavis({ systemStore: createMemorySystemStore(), hostOperations: broker });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), operator);
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  const http = async (method, path, body) => {
    const response = await fetcher(`http://localhost/zelavis/api/v1/runtime${path}`, {
      method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  const catalog = await http("GET", "/host-operations");
  assert.equal(catalog.status, 200);
  assert.deepEqual(await client.hostOperations.catalog(), catalog.body.operations);
  assert.deepEqual((await cli(fetcher, ["catalog"])).stdout, catalog.body);

  const input = { operation: "native.site-reload", projectId: "site-a", arguments: { site: "blog" } };
  const viaHttp = await http("POST", "/host-operations", input);
  assert.equal(viaHttp.status, 202);
  const viaSdk = await client.hostOperations.submit(input);
  const viaCli = await cli(fetcher, ["submit", "native.site-reload", "--project", "site-a", "--arg", "site=blog"]);
  assert.equal(viaCli.exitCode, 0);
  const stable = ({ operationId: _o, requestedAt: _r, agent: { operationId: _a, ...agent }, ...rest }) => ({ ...rest, agent });
  assert.deepEqual(stable(viaSdk), stable(viaHttp.body.operation));
  assert.deepEqual(stable(viaCli.stdout.operation), stable(viaHttp.body.operation));
  assert.equal(submitted.length, 3);

  const id = viaHttp.body.operation.operationId;
  const got = await http("GET", `/host-operations/${id}`);
  assert.deepEqual(await client.hostOperations.get(id), got.body.operation);
  assert.deepEqual((await cli(fetcher, ["get", id])).stdout, got.body);

  // Equivalent refusals.
  const forbidden = await http("POST", "/host-operations", { ...input, projectId: "site-b" });
  assert.equal(forbidden.status, 403);
  await assert.rejects(client.hostOperations.submit({ ...input, projectId: "site-b" }), (error) =>
    error instanceof ZelavisClientHttpError && error.response.status === 403 && error.body.error === forbidden.body.error);
  assert.deepEqual((await cli(fetcher, ["submit", "native.site-reload", "--project", "site-b", "--arg", "site=blog"])).stderr,
    { error: forbidden.body.error, status: 403, details: forbidden.body });
  const anonymous = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/host-operations"));
  assert.ok([401, 403].includes(anonymous.status));

  const unavailable = await zelavis({ systemStore: createMemorySystemStore() });
  t.after(() => unavailable.close());
  const none = await unavailable.fetch(new Request("http://localhost/zelavis/api/v1/runtime/host-operations"), operator);
  assert.equal(none.status, 503);
});

test("a Platform broker drives a real Agent end to end with its own authority key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-broker-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = await createReleaseSigner();
  const body = "printf '%s' \"$4\" > \"$2\"\n"; // argv: --output <path> --value <v>
  const installed = join(root, "operations", "native.mark", "v1");
  await mkdir(installed, { recursive: true, mode: 0o700 });
  await writeFile(join(installed, "artifact"), body, { mode: 0o700 });
  await writeFile(join(installed, "manifest.json"), JSON.stringify(await release.sign({
    id: "native.mark", version: "v1", sha256: sha(body), interpreter: "/bin/sh",
    arguments: { value: { required: true, pattern: "^[a-z]+$" }, output: { required: true, maxLength: 1024 } },
    authorization: { permission: "project.hosting.mark", scope: "project" },
  })));
  const trust = join(root, "operation-trust.json");
  await writeFile(trust, JSON.stringify(release.trust), { mode: 0o644 });
  const authority = await readOrCreatePlatformAuthorityKey(join(root, "platform", "system", "agent-authority"));

  const controller = new AbortController();
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const running = runAgentCommand({
    dataDirectory: join(root, "agent-data"), operationsRoot: join(root, "operations"), operationTrust: trust,
    platformAuthority: authority.trustFile, signal: controller.signal, onReady: ready,
  });
  t.after(async () => { controller.abort(); await running.catch(() => undefined); });
  await readyPromise;
  const agentClient = await createAgentProcessClient({ directory: join(root, "agent-data", "agent") });
  t.after(() => agentClient.close());
  const broker = createHostOperationBroker({ agent: agentClient, signer: authority.signer, store: createMemorySystemStore() });

  const operator = user("alice", { grants: [{ permission: "project.hosting.mark", scope: { type: "project", projectId: "site-a" } }] });
  const output = join(root, "marked");
  const record = await broker.submit({ operation: "native.mark", projectId: "site-a", arguments: { value: "done", output } }, operator);
  let status;
  for (let attempt = 0; attempt < 200 && !["succeeded", "failed"].includes(status); attempt += 1) {
    status = (await broker.get(record.operationId, operator)).agent?.status;
    if (!["succeeded", "failed"].includes(status)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status, "succeeded");
  assert.equal(await readFile(output, "utf8"), "done");
});

test("submissions are rate limited per actor after authorization, and refill over time", async () => {
  const platform = await createReleaseSigner({ keyId: "platform-rate" });
  const { agent, submitted } = fakeAgent();
  let clock = 1_000_000;
  const broker = createHostOperationBroker({
    agent, store: createMemorySystemStore(), now: () => clock,
    signer: { keyId: "platform-rate", privateKey: platform.privateKey },
    rateLimit: { submissionsPerMinute: 6, burst: 2 },
  });
  const { ZelavisHostOperationRateLimitedError } = await import("../dist/index.js");
  const admin = user("admin", { permissions: ["server.hosting.report"] });
  const other = user("other", { permissions: ["server.hosting.report"] });
  const outsider = user("outsider");
  const input = { operation: "native.host-report", deadlineMs: 60_000 };

  // An unauthorized caller neither succeeds nor spends anyone's budget.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(broker.submit(input, outsider), ZelavisHostOperationForbiddenError);
  }
  await broker.submit(input, admin);
  await broker.submit(input, admin);
  await assert.rejects(broker.submit(input, admin), (error) => {
    assert.ok(error instanceof ZelavisHostOperationRateLimitedError);
    assert.equal(error.retryAfterSeconds, 10);
    return true;
  });
  // Budgets are per actor.
  await broker.submit(input, other);
  clock += 10_000;
  await broker.submit(input, admin);
  assert.equal(submitted.length, 4);
});

test("audit reads need the audit permission for their scope and never include argument values", async (t) => {
  const { broker } = await brokerWith();
  const alice = user("alice", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-a" } }] });
  const bob = user("bob", { grants: [{ permission: "project.hosting.reload", scope: { type: "project", projectId: "site-b" } }] });
  await broker.submit({ operation: "native.site-reload", projectId: "site-a", arguments: { site: "secretname" } }, alice);
  await broker.submit({ operation: "native.site-reload", projectId: "site-b", arguments: { site: "other" } }, bob);

  const auditor = user("auditor", { permissions: ["server.host-operations.audit"] });
  const all = await broker.audit({}, auditor);
  assert.deepEqual(all.map((record) => record.projectId).sort(), ["site-a", "site-b"]);
  assert.equal(JSON.stringify(all).includes("secretname"), false);
  const projectAuditor = user("pa", { grants: [{ permission: "project.host-operations.audit", scope: { type: "project", projectId: "site-a" } }] });
  assert.deepEqual((await broker.audit({ projectId: "site-a" }, projectAuditor)).map((record) => record.actorId), ["alice"]);
  await assert.rejects(broker.audit({ projectId: "site-b" }, projectAuditor), ZelavisHostOperationForbiddenError);
  await assert.rejects(broker.audit({}, projectAuditor), ZelavisHostOperationForbiddenError);
  await assert.rejects(broker.audit({ limit: 501 }, auditor), /limit/);
  assert.equal((await broker.audit({ limit: 1 }, auditor)).length, 1);

  // HTTP, SDK and CLI agree, and the audit path is not taken for an operation id.
  const zv = await zelavis({ systemStore: createMemorySystemStore(), hostOperations: broker });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), { principal: auditor });
  const response = await fetcher("http://localhost/zelavis/api/v1/runtime/host-operations/audit?limit=5");
  assert.equal(response.status, 200);
  const body = await response.json();
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });
  assert.deepEqual(await client.hostOperations.audit({ limit: 5 }), body.records);
  assert.deepEqual((await cli(fetcher, ["audit", "--limit", "5"])).stdout, body);
  const denied = await zv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/host-operations/audit"), { principal: alice });
  assert.equal(denied.status, 403);

  // 429 carries Retry-After over HTTP.
  const limited = createHostOperationBroker({
    agent: fakeAgent().agent, store: createMemorySystemStore(),
    signer: { keyId: "platform-unit", privateKey: (await createReleaseSigner({ keyId: "platform-unit" })).privateKey },
    rateLimit: { submissionsPerMinute: 1, burst: 1 },
  });
  const limitedZv = await zelavis({ systemStore: createMemorySystemStore(), hostOperations: limited });
  t.after(() => limitedZv.close());
  const post = () => limitedZv.fetch(new Request("http://localhost/zelavis/api/v1/runtime/host-operations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "native.host-report" }),
  }), { principal: user("root", { permissions: ["*"] }) });
  assert.equal((await post()).status, 202);
  const throttled = await post();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "60");
});
