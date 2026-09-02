import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import {
  createGatewayAuthorityNonce,
  createGatewayAuthoritySecret,
  createGatewayNonceTracker,
  signGatewayAuthority,
  verifyGatewayAuthority,
} from "../dist/platform/gateway-authority.js";

const OWNER = {
  principal: { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] },
};
const VIEWER = {
  principal: {
    id: "viewer",
    type: "user",
    grants: [
      { permission: "project.view", scope: { type: "project", projectId: "alpha" } },
    ],
  },
};

function claims(overrides = {}) {
  return {
    projectId: "alpha",
    scopeId: "local-platform",
    generation: 1,
    runtimeNodeId: "local",
    subject: "owner",
    subjectType: "user",
    permissions: ["project.view"],
    nonce: createGatewayAuthorityNonce(),
    expiresAt: Date.now() + 30_000,
    ...overrides,
  };
}

test("Gateway authority envelopes verify only under their own secret and audience", async () => {
  const secret = createGatewayAuthoritySecret();
  const token = await signGatewayAuthority(secret, claims());

  assert.ok(
    await verifyGatewayAuthority(secret, token, { audienceProjectId: "alpha" }),
    "a well-formed envelope must verify",
  );
  assert.equal(
    await verifyGatewayAuthority(secret, token, { audienceProjectId: "beta" }),
    undefined,
    "an envelope must not be accepted by another Project",
  );
  assert.equal(
    await verifyGatewayAuthority(createGatewayAuthoritySecret(), token, {
      audienceProjectId: "alpha",
    }),
    undefined,
    "a different runtime secret must not verify",
  );
  assert.equal(
    await verifyGatewayAuthority(secret, `${token}x`, {
      audienceProjectId: "alpha",
    }),
    undefined,
    "a tampered signature must not verify",
  );
  assert.equal(
    await verifyGatewayAuthority(secret, "not-a-token", {
      audienceProjectId: "alpha",
    }),
    undefined,
  );
});

test("Gateway authority envelopes expire and are single use", async () => {
  const secret = createGatewayAuthoritySecret();

  const expired = await signGatewayAuthority(
    secret,
    claims({ expiresAt: Date.now() - 1 }),
  );
  assert.equal(
    await verifyGatewayAuthority(secret, expired, { audienceProjectId: "alpha" }),
    undefined,
    "an expired envelope must be refused",
  );

  const farFuture = await signGatewayAuthority(
    secret,
    claims({ expiresAt: Date.now() + 60 * 60 * 1000 }),
  );
  assert.equal(
    await verifyGatewayAuthority(secret, farFuture, {
      audienceProjectId: "alpha",
    }),
    undefined,
    "an implausibly long window must be refused even when it verifies",
  );

  const consumeNonce = createGatewayNonceTracker();
  const once = await signGatewayAuthority(secret, claims());
  assert.ok(
    await verifyGatewayAuthority(secret, once, {
      audienceProjectId: "alpha",
      consumeNonce,
    }),
  );
  assert.equal(
    await verifyGatewayAuthority(secret, once, {
      audienceProjectId: "alpha",
      consumeNonce,
    }),
    undefined,
    "a replayed envelope must be refused",
  );
});

test("Gateway authority never carries a wildcard downstream", async () => {
  const secret = createGatewayAuthoritySecret();
  const token = await signGatewayAuthority(secret, claims({ permissions: ["*"] }));
  assert.equal(
    await verifyGatewayAuthority(secret, token, { audienceProjectId: "alpha" }),
    undefined,
    "a wildcard must not be accepted over the Gateway channel",
  );
});

test("Project runtimes reject forged authority and honour real caller authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-gateway-"));
  const zv = new Zelavis({ adapter: nodeAdapter({ dataDirectory: directory }) });
  const request = (path, init, context = OWNER) =>
    zv.fetch(
      new Request(`http://localhost/zelavis/api/v1/runtime${path}`, init),
      context,
    );

  try {
    const created = await (
      await request("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "alpha",
          name: "Alpha",
          recipeName: "zelavis/app",
        }),
      })
    ).json();
    const childUrl = created.project.runtime.url;
    const accounts = `${childUrl}/zelavis/api/v1/auth/accounts`;

    // The runtime listens on loopback, so a local process can send any header
    // it likes. None of these may produce a principal.
    const forged = await fetch(accounts, {
      headers: {
        "x-zelavis-project-id": "alpha",
        "x-zelavis-platform-scope-id": "local-platform",
        "x-zelavis-placement-generation": "1",
        "x-zelavis-runtime-node-id": "local",
      },
    });
    assert.equal(forged.status, 401, "forged plain headers must not authorize");

    assert.equal((await fetch(accounts)).status, 401);
    assert.equal(
      (
        await fetch(accounts, {
          headers: { "x-zelavis-authority": "bm90LXJlYWw.c2ln" },
        })
      ).status,
      401,
      "an unsigned or bogus envelope must not authorize",
    );

    // The Gateway forwards the caller's real authority, so a viewer reads but
    // cannot mutate.
    assert.equal(
      (
        await request(
          "/projects/alpha/proxy/zelavis/api/v1/runtime/config",
          undefined,
          VIEWER,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/projects/alpha/proxy/zelavis/api/v1/runtime/settings",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ theme: "dark" }),
          },
          VIEWER,
        )
      ).status,
      403,
      "project.view must not authorize a mutation through the Gateway",
    );
    assert.equal(
      (
        await request("/projects/alpha/proxy/zelavis/api/v1/runtime/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ theme: "dark" }),
        })
      ).status,
      200,
      "an owner must still be able to manage the Project runtime",
    );
  } finally {
    await zv.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
