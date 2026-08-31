import assert from "node:assert/strict";
import test from "node:test";

import {
  ZelavisAgentOperationConflictError,
  createAgentNonceTracker,
  createAgentOperationManager,
  createMemorySystemStore,
  signAgentAuthority,
  verifyAgentAuthority,
} from "../dist/index.js";

const DIGEST = "a".repeat(64);

function request(overrides = {}) {
  return {
    operationId: "operation-id-0000001",
    operation: "native.preflight",
    version: "v1",
    artifactDigest: DIGEST,
    authority: "signed-authority-placeholder",
    arguments: { project: "site-a" },
    deadline: new Date(Date.now() + 60_000).toISOString(),
    projectId: "site-a",
    ...overrides,
  };
}

test("Agent authority is short-lived, audience-bound, request-bound, and replay-aware", async () => {
  const secret = "agent-test-secret-that-is-at-least-32-characters";
  const input = request();
  const now = Date.now();
  const claims = {
    agentId: "agent-a",
    operationId: input.operationId,
    operation: input.operation,
    version: input.version,
    artifactDigest: input.artifactDigest,
    projectId: input.projectId,
    actorId: "owner-a",
    issuedAt: now,
    expiresAt: now + 30_000,
    nonce: "nonce-a",
  };
  const authority = await signAgentAuthority(secret, claims);
  const signedRequest = { ...input, authority };
  const consumeNonce = createAgentNonceTracker();

  assert.deepEqual(
    await verifyAgentAuthority(secret, authority, signedRequest, {
      audienceAgentId: "agent-a",
      now: now + 1,
      consumeNonce,
    }),
    claims,
  );
  assert.equal(
    await verifyAgentAuthority(secret, authority, signedRequest, {
      audienceAgentId: "agent-a",
      now: now + 1,
      consumeNonce,
    }),
    undefined,
  );
  assert.equal(
    await verifyAgentAuthority(secret, authority, signedRequest, {
      audienceAgentId: "agent-b",
      now: now + 1,
    }),
    undefined,
  );
  assert.equal(
    await verifyAgentAuthority(secret, authority, {
      ...signedRequest,
      projectId: "site-b",
    }, {
      audienceAgentId: "agent-a",
      now: now + 1,
    }),
    undefined,
  );
});

test("Agent journal persists operations, redacts authority, and rejects id reuse", async () => {
  const store = createMemorySystemStore();
  let executions = 0;
  const manager = await createAgentOperationManager({
    store,
    executor: {
      async execute(input) {
        executions += 1;
        return {
          operationId: input.operationId,
          operation: input.operation,
          version: input.version,
          status: "succeeded",
          exitCode: 0,
          stdout: "sensitive output is not journaled",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    },
  });

  const submitted = await manager.submit(request());
  assert.equal(submitted.status, "queued");
  await manager.reconcile();
  const completed = await manager.get(request().operationId);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.attempts, 1);
  assert.equal(completed.exitCode, 0);
  assert.equal("authority" in completed, false);
  assert.equal("arguments" in completed, false);
  assert.deepEqual(completed.events.map((event) => event.type), [
    "submitted",
    "claimed",
    "succeeded",
  ]);
  assert.equal(
    (await store.get("agent-operations", request().operationId)).value.request.authority,
    "redacted-after-execution",
  );

  const duplicate = await manager.submit(request());
  assert.equal(duplicate.status, "succeeded");
  assert.equal(executions, 1);
  await assert.rejects(
    manager.submit(request({ arguments: { project: "site-b" } })),
    ZelavisAgentOperationConflictError,
  );

  const restored = await createAgentOperationManager({
    store,
    executor: { execute: async () => { throw new Error("must not run"); } },
  });
  assert.equal(restored.identity.id, manager.identity.id);
  assert.equal((await restored.get(request().operationId)).status, "succeeded");
  await manager.close();
  await restored.close();
});

test("an expired Agent lease is atomically recovered by a new executor owner", async () => {
  const store = createMemorySystemStore();
  let releaseFirst;
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const first = await createAgentOperationManager({
    store,
    executor: { execute: () => firstResult },
  });
  const input = request({ operationId: "operation-id-0000002" });
  await first.submit(input);

  let runningRecord;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    runningRecord = await store.get("agent-operations", input.operationId);
    if (runningRecord?.value.status === "running") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runningRecord.value.status, "running");
  const expired = {
    ...runningRecord.value,
    lease: {
      ...runningRecord.value.lease,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
  };
  assert.ok(await store.compareAndSet(
    "agent-operations",
    input.operationId,
    runningRecord.updatedAt,
    expired,
  ));

  const second = await createAgentOperationManager({
    store,
    executor: {
      async execute(next) {
        return {
          operationId: next.operationId,
          operation: next.operation,
          version: next.version,
          status: "succeeded",
          exitCode: 0,
          stdout: "",
          stderr: "",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      },
    },
  });
  await second.reconcile();
  const recovered = await second.get(input.operationId);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attempts, 2);
  assert.ok(recovered.events.some((event) => event.type === "recovered"));

  releaseFirst({
    operationId: input.operationId,
    operation: input.operation,
    version: input.version,
    status: "succeeded",
    exitCode: 0,
    stdout: "",
    stderr: "",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  await first.close();
  await second.close();
  assert.equal((await second.get(input.operationId)).attempts, 2);
});
