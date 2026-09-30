import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  Zelavis,
  createAssistantApprovalStore,
  createAssistantToolbox,
  createMemorySystemStore,
  createProjectLifecycleTools,
} from "../dist/index.js";

const grant = (permission, projectId) => ({ permission, scope: { type: "project", projectId } });
const operator = {
  id: "op", type: "user",
  grants: [grant("project.runtime.manage", "p1"), grant("project.delete", "p1")],
};

function setup({ withApprovals = true, failStop = false } = {}) {
  const calls = [];
  const projects = {
    start: async (id) => { calls.push(["start", id]); },
    stop: async (id) => { calls.push(["stop", id]); if (failStop) throw new Error("driver refused"); },
    restart: async (id) => { calls.push(["restart", id]); },
    remove: async (id) => { calls.push(["remove", id]); return true; },
  };
  const store = createMemorySystemStore();
  const approvals = createAssistantApprovalStore(store);
  const audit = [];
  const box = createAssistantToolbox({
    tools: createProjectLifecycleTools(() => projects),
    audit: async (record) => { audit.push(record); },
    ...(withApprovals ? { approvals } : {}),
  });
  return { box, calls, approvals, audit };
}

async function request(box, principal = operator, name = "stop_project", projectId = "p1", threadId = "t1") {
  return box.run(principal, { name, arguments: { projectId } }, { threadId });
}

test("a change becomes a request and does not run", async () => {
  const { box, calls, approvals, audit } = setup();
  const result = await request(box);
  assert.equal(result.ok, false);
  assert.equal(result.refusal.code, "approval_required");
  assert.deepEqual(result.refusal.approval.target, { kind: "project", id: "p1" });
  assert.equal(result.refusal.approval.label, "Stop Project p1");
  assert.deepEqual(calls, []);
  const stored = await approvals.get(result.refusal.approval.id);
  assert.equal(stored.status, "pending");
  assert.deepEqual(stored.arguments, { projectId: "p1" });
  assert.deepEqual(audit.map((a) => a.decision), ["pending_approval"]);
});

test("the first gate still applies: no permission, no request", async () => {
  const { box, approvals } = setup();
  const nobody = { id: "n", type: "user", grants: [grant("project.view", "p1")] };
  const result = await request(box, nobody);
  assert.equal(result.refusal.code, "forbidden");
  assert.deepEqual(await approvals.listForThread("t1"), []);
  const otherProject = await request(box, operator, "stop_project", "p2");
  assert.equal(otherProject.refusal.code, "forbidden");
});

test("changes are refused, not run, where approval is not available", async () => {
  const { box, calls } = setup({ withApprovals: false });
  assert.equal((await request(box)).refusal.code, "approval_unavailable");
  const { box: withStore } = setup();
  const noThread = await withStore.run(operator, { name: "stop_project", arguments: { projectId: "p1" } });
  assert.equal(noThread.refusal.code, "approval_unavailable");
  assert.deepEqual(calls, []);
});

test("approving runs the stored change exactly once, even when decided twice at once", async () => {
  const { box, calls, approvals, audit } = setup();
  const { approval } = (await request(box)).refusal;
  const decide = () => box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "approve" });
  const results = await Promise.all([decide(), decide(), decide()]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "already_decided"));
  assert.deepEqual(calls, [["stop", "p1"]]);
  const stored = await approvals.get(approval.id);
  assert.equal(stored.status, "executed");
  assert.equal(stored.outcome, "Done: Stop Project p1.");
  assert.deepEqual(audit.map((a) => a.decision), ["pending_approval", "allowed", "executed"]);
  const again = await decide();
  assert.equal(again.code, "already_decided");
  assert.deepEqual(calls, [["stop", "p1"]]);
});

test("denying changes nothing", async () => {
  const { box, calls, approvals } = setup();
  const { approval } = (await request(box)).refusal;
  const result = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "deny" });
  assert.equal(result.ok, true);
  assert.equal(result.approval.status, "denied");
  assert.equal((await approvals.get(approval.id)).status, "denied");
  assert.deepEqual(calls, []);
  const late = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "approve" });
  assert.equal(late.code, "already_decided");
});

test("only the requester, in that thread, can decide", async () => {
  const { box, calls } = setup();
  const { approval } = (await request(box)).refusal;
  const stranger = { ...operator, id: "someone-else" };
  const asStranger = await box.resolveApproval(stranger, { approvalId: approval.id, threadId: "t1", decision: "approve" });
  assert.equal(asStranger.code, "not_found");
  const wrongThread = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t2", decision: "approve" });
  assert.equal(wrongThread.code, "not_found");
  assert.equal((await box.resolveApproval(operator, { approvalId: "nope", threadId: "t1", decision: "approve" })).code, "not_found");
  assert.deepEqual(calls, []);
});

test("approval is a second gate: a revoked permission stops the change", async () => {
  const { box, calls, approvals } = setup();
  const { approval } = (await request(box)).refusal;
  const revoked = { ...operator, grants: [] };
  const result = await box.resolveApproval(revoked, { approvalId: approval.id, threadId: "t1", decision: "approve" });
  assert.equal(result.code, "forbidden");
  assert.deepEqual(calls, []);
  assert.equal((await approvals.get(approval.id)).status, "denied");
});

test("an irreversible change must name its target", async () => {
  const { box, calls, approvals } = setup();
  const { approval } = (await request(box, operator, "delete_project")).refusal;
  assert.equal(approval.irreversible, true);
  for (const confirm of [undefined, "", "p2", "P1", " p1"]) {
    const result = await box.resolveApproval(operator, {
      approvalId: approval.id, threadId: "t1", decision: "approve", ...(confirm === undefined ? {} : { confirm }),
    });
    assert.equal(result.code, "confirmation_required", String(confirm));
  }
  assert.deepEqual(calls, []);
  assert.equal((await approvals.get(approval.id)).status, "pending");
  const ok = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "approve", confirm: "p1" });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [["remove", "p1"]]);
});

test("a request expires", async () => {
  const { box, calls, approvals } = setup();
  const { approval } = (await request(box)).refusal;
  const later = Date.now() + 11 * 60_000;
  const clock = mock.method(Date, "now", () => later);
  try {
    const result = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "approve" });
    assert.equal(result.code, "expired");
  } finally {
    clock.mock.restore();
  }
  assert.deepEqual(calls, []);
  assert.equal((await approvals.get(approval.id)).status, "expired");
});

test("a change that fails is recorded as failed with its reason", async () => {
  const { box, approvals } = setup({ failStop: true });
  const { approval } = (await request(box)).refusal;
  const result = await box.resolveApproval(operator, { approvalId: approval.id, threadId: "t1", decision: "approve" });
  assert.equal(result.code, "failed");
  const stored = await approvals.get(approval.id);
  assert.equal(stored.status, "failed");
  assert.match(stored.outcome, /driver refused/);
});

test("too many waiting requests are refused", async () => {
  const { box } = setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await request(box)).refusal.code, "approval_required");
  assert.equal((await request(box)).refusal.code, "approval_unavailable");
});

test("over HTTP: the model asks, a person decides, the thread records it", async () => {
  let step = 0;
  const model = { name: "m", generate: async () => step++ === 0
    ? { content: "", toolCalls: [{ id: "c", name: "stop_project", arguments: { projectId: "p1" } }] }
    : { content: "I asked to stop p1.", toolCalls: [] } };
  const zv = new Zelavis({ assistant: { model } });
  const user = { id: "u", type: "user", permissions: ["assistant.use"],
    grants: [grant("project.runtime.manage", "p1"), grant("project.view", "p1")] };
  const call = (principal, path, init) => zv.fetch(
    new Request(`http://localhost/zelavis/api/v1/runtime/assistant${path}`, init), { principal });
  const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const thread = (await (await call(user, "/threads", post({}))).json()).thread;
  const reply = await (await call(user, `/threads/${thread.id}/messages`, post({ content: "stop p1" }))).json();
  assert.equal(reply.assistantMessage.approvalIds.length, 1);
  assert.equal(reply.assistantMessage.activity[0].status, "awaiting");
  const approvalId = reply.assistantMessage.approvalIds[0];

  const shown = await (await call(user, `/threads/${thread.id}`)).json();
  assert.equal(shown.approvals[0].status, "pending");

  const bad = await call(user, `/threads/${thread.id}/approvals/${approvalId}`, post({ decision: "maybe" }));
  assert.equal(bad.status, 400);
  const stranger = { ...user, id: "other" };
  assert.equal((await call(stranger, `/threads/${thread.id}/approvals/${approvalId}`, post({ decision: "deny" }))).status, 404);

  const denied = await call(user, `/threads/${thread.id}/approvals/${approvalId}`, post({ decision: "deny" }));
  assert.equal(denied.status, 200);
  const body = await denied.json();
  assert.equal(body.approval.status, "denied");
  assert.match(body.message.content, /did not stop Project p1/i);
  const after = await (await call(user, `/threads/${thread.id}`)).json();
  assert.equal(after.thread.messages.length, 3);
  assert.equal((await call(user, `/threads/${thread.id}/approvals/${approvalId}`, post({ decision: "approve" }))).status, 409);
});
