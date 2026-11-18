import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { createBrowserZelavisClient } from "../dist/sdk/browser.js";

const baseUrl = "http://localhost";
const password = "paper lantern holds a cloud";
const bootstrapToken = "zelavis-bootstrap-token-of-at-least-32-chars";
const namespace = "test-session";
const makeStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key), get size() { return values.size; },
  };
};

test("browser bearer sessions refresh once for concurrent expired calls and discard noSession", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: bootstrapToken },
    subsystems: { auth: { ttl: { accessTokenTtlSeconds: 60 } } },
  });
  t.after(() => runtime.close());
  const storage = makeStorage();
  let refreshes = 0;
  const sent = [];
  const fetch = async (url, init) => {
    const request = new Request(url, init);
    if (url.pathname.endsWith("/auth/session/refresh")) refreshes++;
    if (url.pathname.endsWith("/runtime/access")) sent.push(request.headers.get("authorization"));
    return runtime.fetch(request);
  };
  const session = createBrowserZelavisClient({ baseUrl, fetch, authSession: { storage, namespace } });
  const peer = createBrowserZelavisClient({ baseUrl, fetch, authSession: { storage, namespace } });
  const claimed = await session.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
  assert.equal(storage.size, 1);
  assert.equal((await peer.auth.session.current()).account.id, claimed.userId);
  now += 61_000;
  const [raw] = await Promise.all([session.request("/runtime/access"), peer.json("/runtime/access"), peer.auth.session.current()]);
  assert.equal(raw.status, 200);
  assert.equal(refreshes, 1);
  assert.ok(sent.every(Boolean));

  assert.equal((await session.auth.session.refresh()).kind, "rotated");
  assert.equal(refreshes, 2);
  const current = await peer.auth.session.current();
  await session.auth.sessions.revoke(current.sessionId);
  now += 61_000;
  await assert.rejects(peer.auth.session.current(), { status: 401, code: "access_token_expired" });
  assert.equal(storage.size, 0);
  assert.equal(refreshes, 3);
  await assert.rejects(session.auth.session.current(), { status: 401, code: "not_signed_in" });
});

test("browser bearer sign-out evicts the persisted session and revokes it", async (t) => {
  const runtime = await zelavis({ systemStore: createMemorySystemStore(), bootstrap: { token: bootstrapToken } });
  t.after(() => runtime.close());
  const storage = makeStorage();
  const fetch = (url, init) => runtime.fetch(new Request(url, init));
  const client = createBrowserZelavisClient({ baseUrl, fetch, authSession: { storage, namespace } });
  const claimed = await client.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
  await client.auth.session.signOut();
  assert.equal(storage.size, 0);
  const response = await fetch(new URL("/zelavis/api/v1/auth/session", baseUrl), {
    headers: { authorization: `Bearer ${claimed.tokens.accessToken}` },
  });
  assert.equal(response.status, 401);
});
