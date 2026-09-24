import assert from "node:assert/strict";
import test from "node:test";

import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { openTemporaryDatabase } from "./_database.mjs";

test("remote environment routes and SDK preserve the session/process boundary", async (t) => {
  const calls = [];
  const eventReads = [];
  const { api: database } = await openTemporaryDatabase(t);
  const zv = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { database },
    remoteEnvironment: {
      identity: { id: "env-1", platform: "test" },
      health: () => ({ status: "healthy", checkedAt: "2026-01-01T00:00:00Z" }),
      async createSession(input) {
        calls.push(["session", input]);
        return { id: "session-1", status: "active", createdAt: "2026-01-01T00:00:00Z" };
      },
      async startProcess(sessionId, input) {
        calls.push(["process", sessionId, input]);
        return { id: "process-1", sessionId, status: "running" };
      },
      async operateProcess(processId, input) {
        calls.push(["operation", processId, input]);
        return {
          accepted: true,
          process: {
            id: processId,
            sessionId: "session-1",
            status: input.type === "terminate" ? "exited" : "running",
            ...(input.type === "terminate" ? { exitCode: 143 } : {}),
          },
        };
      },
      async readEvents(sessionId, options) {
        eventReads.push([sessionId, options]);
        return {
          events: [{
            cursor: "event-2",
            sessionId,
            processId: "process-1",
            type: "stdout",
            timestamp: "2026-01-01T00:00:01Z",
            data: "ready",
          }],
          cursor: "event-2",
          hasMore: false,
        };
      },
    },
  });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), {
    principal: { id: "owner", type: "user", metadata: { tenantId: "tenant-1" }, permissions: ["*"] },
  });
  const client = createZelavisClient({ baseUrl: "http://localhost", fetch: fetcher });

  assert.deepEqual(await client.environment.identity(), { id: "env-1", platform: "test" });
  assert.equal((await client.runtime.access()).principal.id, "owner");
  assert.equal((await client.environment.health()).status, "healthy");
  const session = await client.environment.createSession({
    scope: { tenantId: "tenant-1", projectId: "project-1", laneId: "lane-1" },
    metadata: { source: "test" },
  });
  const persisted = await database.forTenant("tenant-1").documents.findById({
    collection: "zelavis_agent_sessions",
    id: session.id,
  });
  assert.equal(persisted?.data.scope.projectId, "project-1");
  assert.equal(typeof persisted?.version, "number");
  const projected = await client.environment.updateSession(session.id, {
    expectedVersion: persisted.version,
    metadata: { source: "test", fluxgent: { session: "running", activeRunId: "run-1" } },
  });
  assert.equal(projected.metadata.fluxgent.activeRunId, "run-1");
  assert.equal(projected.version, persisted.version + 1);
  await assert.rejects(
    client.environment.updateSession(session.id, {
      expectedVersion: persisted.version,
      metadata: { source: "test", fluxgent: { session: "idle" } },
    }),
    /changed concurrently|409|Conflict/i,
  );
  assert.equal((await client.environment.getSession(session.id)).scope.projectId, "project-1");
  const contextUsage = await client.environment.recordUsage(session.id, {
    runId: "run-1",
    source: "provider",
    contextTokens: 1200,
    contextLimit: 200000,
  });
  const turnUsage = await client.environment.recordUsage(session.id, {
    runId: "run-1",
    source: "provider",
    inputTokens: 900,
    outputTokens: 75,
    cacheReadTokens: 300,
    premiumRequests: 1,
    model: "agent-model",
  });
  assert.equal(turnUsage.id, contextUsage.id);
  assert.equal(turnUsage.version, contextUsage.version + 1);
  assert.equal(turnUsage.contextTokens, 1200);
  assert.equal(turnUsage.outputTokens, 75);
  assert.equal(turnUsage.projectId, "project-1");
  assert.equal(turnUsage.laneId, "lane-1");
  const persistedUsage = await database.forTenant("tenant-1").documents.findMany({
    collection: "zelavis_agent_usage",
    where: [{ path: "sessionId", value: session.id }],
  });
  assert.equal(persistedUsage.length, 1, "repeated reports for one run merge idempotently");
  const process = await client.environment.startProcess(session.id, { command: "agent", cwd: "/workspace" });
  const persistedProcess = await database.forTenant("tenant-1").documents.findById({
    collection: "zelavis_agent_processes",
    id: process.id,
  });
  assert.equal(persistedProcess?.data.sessionId, session.id);
  assert.equal((await client.environment.getProcess(process.id)).status, "running");
  const events = await client.environment.readEvents(session.id, { after: "event-1", limit: 25 });
  assert.equal(events.events[0].data, "ready");
  assert.deepEqual(eventReads, [[session.id, { after: "event-1", limit: 25 }]]);
  await client.environment.operateProcess(process.id, { type: "stdin", data: "hello" });
  await client.environment.operateProcess(process.id, { type: "terminate" });
  const exitedProcess = await database.forTenant("tenant-1").documents.findById({
    collection: "zelavis_agent_processes",
    id: process.id,
  });
  assert.equal(exitedProcess?.data.status, "exited");
  assert.equal(exitedProcess?.data.exitCode, 143);
  assert.deepEqual(calls.map(([kind]) => kind), ["session", "process", "operation", "operation"]);
  assert.deepEqual(calls[0][1].scope, { tenantId: "tenant-1", projectId: "project-1", laneId: "lane-1" });
  assert.equal(calls[1][2].cwd, "/workspace");
  const invalid = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions/session-1/processes",
    { method: "POST", body: JSON.stringify({ command: "agent" }) },
  );
  assert.equal(invalid.status, 400);
  const invalidArgs = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions/session-1/processes",
    { method: "POST", body: JSON.stringify({ command: "agent", cwd: "/workspace", args: ["ok", 7] }) },
  );
  assert.equal(invalidArgs.status, 400);
  const invalidEnv = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions/session-1/processes",
    { method: "POST", body: JSON.stringify({ command: "agent", cwd: "/workspace", env: { TOKEN: 7 } }) },
  );
  assert.equal(invalidEnv.status, 400);
  const invalidOperation = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/processes/process-1/operations",
    { method: "POST", body: JSON.stringify({ type: "unknown" }) },
  );
  assert.equal(invalidOperation.status, 400);
  const missingInput = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/processes/process-1/operations",
    { method: "POST", body: JSON.stringify({ type: "stdin" }) },
  );
  assert.equal(missingInput.status, 400);
  const invalidEventLimit = await fetcher(
    `http://localhost/zelavis/api/v1/runtime/environment/sessions/${session.id}/events?limit=0`,
  );
  assert.equal(invalidEventLimit.status, 400);
  const invalidUsage = await fetcher(
    `http://localhost/zelavis/api/v1/runtime/environment/sessions/${session.id}/usage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-invalid", source: "provider", inputTokens: -1 }),
    },
  );
  assert.equal(invalidUsage.status, 400);
  assert.deepEqual(await client.environment.closeSession(session.id), { closed: true });
  const closedSession = await database.forTenant("tenant-1").documents.findById({
    collection: "zelavis_agent_sessions",
    id: session.id,
  });
  assert.equal(closedSession?.data.status, "closed");
  assert.equal((await client.environment.getSession(session.id)).status, "closed");
  const forbidden = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        scope: { tenantId: "other-tenant", projectId: "project-1", laneId: "lane-1" },
      }),
    },
  );
  assert.equal(forbidden.status, 403);
  const foreignRead = await zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/environment/sessions/${session.id}`),
    { principal: { id: "other", type: "user", metadata: { tenantId: "tenant-2" }, permissions: ["*"] } },
  );
  assert.equal(foreignRead.status, 404);
  assert.equal(calls.length, 4);
});

test("remote environment compensates provider resources when tenant persistence fails", async (t) => {
  const providerCalls = [];
  const { api: database } = await openTemporaryDatabase(t);
  let rejectedCollection;
  let sessionSequence = 0;
  let processSequence = 0;
  const failingDatabase = {
    ...database,
    forTenant(tenantId) {
      const tenant = database.forTenant(tenantId);
      return {
        ...tenant,
        documents: {
          ...tenant.documents,
          insert: async (input) => {
            if (input.collection === rejectedCollection) {
              throw new Error(`refused ${input.collection}`);
            }
            return tenant.documents.insert(input);
          },
        },
      };
    },
  };
  const zv = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { database: failingDatabase },
    remoteEnvironment: {
      identity: { id: "env-compensation", platform: "test" },
      health: () => ({ status: "healthy", checkedAt: "2026-01-01T00:00:00Z" }),
      async createSession() {
        sessionSequence += 1;
        return {
          id: `session-${sessionSequence}`,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      async closeSession(sessionId) {
        providerCalls.push(["close", sessionId]);
      },
      async startProcess(sessionId) {
        processSequence += 1;
        return { id: `process-${processSequence}`, sessionId, status: "running" };
      },
      async operateProcess(processId, input) {
        providerCalls.push(["operate", processId, input]);
        return {
          accepted: true,
          process: { id: processId, sessionId: "session-1", status: "exited", exitCode: 143 },
        };
      },
    },
  });
  t.after(() => zv.close());
  const fetcher = (url, init) => zv.fetch(new Request(url, init), {
    principal: { id: "owner", type: "user", metadata: { tenantId: "tenant-1" }, permissions: ["*"] },
  });

  const sessionResponse = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { tenantId: "tenant-1", projectId: "project-1", laneId: "lane-1" },
      }),
    },
  );
  assert.equal(sessionResponse.status, 201);

  rejectedCollection = "zelavis_agent_processes";
  const processResponse = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions/session-1/processes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "agent", cwd: "/workspace" }),
    },
  );
  assert.equal(processResponse.status, 500);
  assert.deepEqual(providerCalls.pop(), ["operate", "process-1", { type: "terminate" }]);

  rejectedCollection = "zelavis_agent_sessions";
  const failedSessionResponse = await fetcher(
    "http://localhost/zelavis/api/v1/runtime/environment/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: { tenantId: "tenant-1", projectId: "project-1", laneId: "lane-2" },
      }),
    },
  );
  assert.equal(failedSessionResponse.status, 500);
  assert.deepEqual(providerCalls.pop(), ["close", "session-2"]);
});

test("resuming a session reconciles tenant process projections with the provider", async (t) => {
  const { api: database } = await openTemporaryDatabase(t);
  const tenant = database.forTenant("tenant-1");
  await tenant.documents.createCollection({ name: "zelavis_agent_sessions" });
  await tenant.documents.createCollection({ name: "zelavis_agent_processes" });
  await tenant.documents.insert({
    collection: "zelavis_agent_sessions",
    id: "session-1",
    data: {
      sessionId: "session-1",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      scope: { tenantId: "tenant-1", projectId: "project-1", laneId: "lane-1" },
      metadata: {},
    },
  });
  await tenant.documents.insert({
    collection: "zelavis_agent_processes",
    id: "process-attached",
    data: {
      processId: "process-attached",
      sessionId: "session-1",
      status: "starting",
      startedAt: "",
      exitCode: null,
    },
  });
  await tenant.documents.insert({
    collection: "zelavis_agent_processes",
    id: "process-missing",
    data: {
      processId: "process-missing",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-01-01T00:00:01Z",
      exitCode: null,
    },
  });

  const calls = [];
  const zv = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { database },
    remoteEnvironment: {
      identity: { id: "env-reconcile", platform: "test" },
      health: () => ({ status: "healthy", checkedAt: "2026-01-01T00:00:00Z" }),
      async createSession() {
        throw new Error("not used");
      },
      async resumeSession(session) {
        calls.push(["resume", session.id]);
        return session;
      },
      async listProcesses(sessionId) {
        calls.push(["list", sessionId]);
        return [
          {
            id: "process-attached",
            sessionId,
            status: "running",
            startedAt: "2026-01-01T00:00:01Z",
          },
          {
            id: "process-orphan",
            sessionId,
            status: "exited",
            startedAt: "2026-01-01T00:00:02Z",
            exitCode: 0,
          },
        ];
      },
      async startProcess() {
        throw new Error("not used");
      },
      async operateProcess() {
        throw new Error("not used");
      },
    },
  });
  t.after(() => zv.close());
  const client = createZelavisClient({
    baseUrl: "http://localhost",
    fetch: (url, init) => zv.fetch(new Request(url, init), {
      principal: { id: "owner", type: "user", metadata: { tenantId: "tenant-1" }, permissions: ["*"] },
    }),
  });

  assert.equal((await client.environment.getSession("session-1")).status, "active");
  assert.deepEqual(calls, [["resume", "session-1"], ["list", "session-1"]]);
  const attached = await tenant.documents.findById({
    collection: "zelavis_agent_processes",
    id: "process-attached",
  });
  const missing = await tenant.documents.findById({
    collection: "zelavis_agent_processes",
    id: "process-missing",
  });
  const orphan = await tenant.documents.findById({
    collection: "zelavis_agent_processes",
    id: "process-orphan",
  });
  assert.equal(attached?.data.status, "running");
  assert.equal(attached?.data.startedAt, "2026-01-01T00:00:01Z");
  assert.equal(missing?.data.status, "failed");
  assert.equal(orphan?.data.status, "exited");
  assert.equal(orphan?.data.exitCode, 0);
});
