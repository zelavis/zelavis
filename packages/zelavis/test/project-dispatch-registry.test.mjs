import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";

import { createHttpsProjectDispatcher } from "../dist/adapters/_project-dispatch-https.js";

const destination = (agentId) => ({
  url: "https://203.0.113.10:8443",
  caPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
  agentId,
});
const stopRequest = (nodeId) => ({
  action: "stop",
  placement: { projectId: "project-a", nodeId, ownerSession: "session-a", epoch: 3 },
});

async function dispatcher({ destinations = {}, resolveDestination } = {}) {
  const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return createHttpsProjectDispatcher({
    localNodeId: "local", projectsDirectory: "/nonexistent", destinations,
    ...(resolveDestination ? { resolveDestination } : {}),
    keyId: "platform-a", privateKey,
  });
}

/** The signed claims are a canonical positional array. */
function claimsOf(authority) {
  const [keyId, agentId, action, projectId, nodeId, ownerSession, epoch] =
    JSON.parse(Buffer.from(authority.split(".")[0], "base64url").toString("utf8"));
  return { keyId, agentId, action, projectId, nodeId, ownerSession, epoch };
}

test("a node that is not configured is looked up in the registry, and authority is bound to its Agent", async () => {
  const lookups = [];
  const subject = await dispatcher({
    resolveDestination: (nodeId) => Effect.sync(() => {
      lookups.push(nodeId);
      return nodeId === "enrolled" ? destination("agent-enrolled") : undefined;
    }),
  });
  const authority = await subject.authorizeDispatch(stopRequest("enrolled"));
  assert.deepEqual(lookups, ["enrolled"]);
  const claims = claimsOf(authority);
  assert.equal(claims.agentId, "agent-enrolled", "signed for the registered Agent, not any other");
  assert.equal(claims.nodeId, "enrolled");
  assert.equal(claims.action, "stop");
});

test("a configured node wins over the registry, which is not consulted", async () => {
  let consulted = false;
  const subject = await dispatcher({
    destinations: { fixed: destination("agent-fixed") },
    resolveDestination: () => Effect.sync(() => { consulted = true; return destination("agent-registry"); }),
  });
  const claims = claimsOf(await subject.authorizeDispatch(stopRequest("fixed")));
  assert.equal(consulted, false);
  assert.equal(claims.agentId, "agent-fixed");
});

test("a node known to neither is refused with the same message as before", async () => {
  const subject = await dispatcher({ resolveDestination: () => Effect.succeed(undefined) });
  await assert.rejects(() => subject.authorizeDispatch(stopRequest("ghost")),
    /No Agent endpoint is configured for Node "ghost"\./);
  const without = await dispatcher();
  await assert.rejects(() => without.authorizeDispatch(stopRequest("ghost")),
    /No Agent endpoint is configured for Node "ghost"\./);
});

test("a registry destination that is not a pinned https origin is refused", async () => {
  const subject = await dispatcher({
    resolveDestination: () => Effect.succeed({ ...destination("agent-x"), url: "http://203.0.113.10:8443" }),
  });
  await assert.rejects(() => subject.authorizeDispatch(stopRequest("x")), /HTTPS origin with a pinned CA/);
});

test("a failing registry lookup fails the dispatch instead of falling through", async () => {
  const subject = await dispatcher({ resolveDestination: () => Effect.fail(new Error("registry unavailable")) });
  await assert.rejects(() => subject.authorizeDispatch(stopRequest("x")), /registry unavailable/);
});
