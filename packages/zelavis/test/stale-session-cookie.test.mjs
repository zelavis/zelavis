import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const TOKEN = "stale-cookie-bootstrap-token-32-characters";
const PASSWORD = "correct horse battery staple";

async function platformWithOwner() {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    bootstrap: { token: TOKEN },
  });
  await runtime.plain({
    url: "/zelavis/api/v1/auth/bootstrap",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: {
      bootstrapToken: TOKEN,
      provider: "password",
      account: { email: "owner@example.com" },
      credential: { identifier: "owner@example.com", password: PASSWORD },
    },
  });
  return runtime;
}

const STALE = { cookie: "zelavis_session=zvs_from_another_installation" };

test("a stale session cookie does not lock someone out of signing in", async () => {
  const runtime = await platformWithOwner();

  // A cookie rides along on every request whether or not the caller meant to
  // authenticate. Rejecting on a stale one made the public sign-in endpoint
  // answer 401, and the only way through was clearing cookies by hand.
  const signIn = await runtime.plain({
    url: "/zelavis/api/v1/auth/authenticate/password",
    method: "POST",
    headers: STALE,
    body: { identifier: "owner@example.com", password: PASSWORD },
  });
  assert.equal(signIn.status, 200);
});

test("a stale cookie leaves public endpoints public", async () => {
  const runtime = await platformWithOwner();

  for (const url of [
    "/zelavis/api/v1/auth/bootstrap",
    "/zelavis/api/v1/runtime/config",
  ]) {
    const response = await runtime.plain({ url, headers: STALE });
    assert.equal(response.status, 200, `${url} answered ${response.status}`);
  }
});

test("a stale cookie is anonymous rather than authenticated", async () => {
  const runtime = await platformWithOwner();
  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: STALE,
  });

  // Treated as not signed in, which is what it is — never as the account the
  // expired session used to belong to.
  assert.notEqual(access.body?.mode, "owner");
});

test("an invalid bearer token is still an error", async () => {
  const runtime = await platformWithOwner();
  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { authorization: "Bearer zvs_bogus" },
  });

  // A bearer token is an assertion the caller chose to make. Presenting an
  // invalid one is worth reporting rather than silently ignoring.
  assert.equal(access.status, 401);
});

test("a valid cookie still authenticates", async () => {
  const runtime = await platformWithOwner();
  const signIn = await runtime.plain({
    url: "/zelavis/api/v1/auth/authenticate/password",
    method: "POST",
    headers: { origin: "http://localhost" },
    body: { identifier: "owner@example.com", password: PASSWORD },
  });
  const cookie = signIn.headers["set-cookie"].split(";", 1)[0];

  const access = await runtime.plain({
    url: "/zelavis/api/v1/runtime/access",
    headers: { cookie },
  });
  assert.equal(access.body.mode, "owner");
});
