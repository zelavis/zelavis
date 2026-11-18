/**
 * Zelavis Auth core over HTTP and through the request authenticator: the session routes, the key set, cookies and
 * the principal, composed the way a runtime composes them (`createServiceRuntime` with the routes and authenticator).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { SignJWT, createLocalJWKSet, decodeJwt, importJWK, jwtVerify } from "jose";
import { createServiceRuntime } from "../dist/core/index.js";
import { decryptSecret } from "../dist/edge/acme-crypto.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { keysTables } from "../dist/auth/keys/tables.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { TEST_MASTER_SECRET, bindTestMethod, openAuth } from "./_auth.mjs";

const ORIGIN = "https://auth.example.test";

async function compose(t, options = {}) {
  const a = await openAuth(t, options);
  const method = bindTestMethod(a.auth);
  const runtime = await createServiceRuntime({
    endpointGroups: [{
      id: "auth",
      basePath: "/auth",
      api: { v1: a.auth.routes },
      context: a.auth,
      authenticators: [a.auth.requestAuthenticator],
      origin: { type: "subsystem", subsystem: "auth-test" },
    }],
  });
  const call = (path, { method: verb = "GET", headers = {}, body, origin = ORIGIN } = {}) => runtime.fetch(new Request(`${origin}/auth/${path}`, {
    method: verb,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const bearer = (bundle) => ({ authorization: `Bearer ${bundle.accessToken}` });
  return { ...a, method, runtime, call, bearer, signUp: (request) => a.run(method.signUp({}, request)) };
}

const cookieLines = (response) => response.headers.getSetCookie();
const expectJson = async (response, status) => {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}`);
  return response.json();
};
const privateKeyOf = async (a, kid) => {
  const row = (await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(keysTables.signingKeys).withIndex("by_kid", (q) => q.eq("kid", kid)).unique())));
  return { row, key: await importJWK(JSON.parse(decryptSecret(row.sealedPrivateJwk, `${TEST_MASTER_SECRET}\u0000zelavis.auth.signing`)), "ES256") };
};

test("sign-up through a bound method creates one account, one session and one issued token; a failing body creates none", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const count = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect())).then((rows) => rows.length);
  assert.equal(await count(accountsTables.accounts), 1);
  assert.equal(await count(coreTables.sessions), 1);
  const tokens = await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(coreTables.refreshTokens).collect()));
  assert.deepEqual(tokens.map((token) => token.state), ["issued"]);
  const [account] = await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(accountsTables.accounts).collect()));
  assert.equal(account._id, bundle.userId);
  assert.deepEqual(account.roles, ["customer"]);
  assert.equal(typeof account.lastSignInAt, "number");
  const failing = a.method.bound.mutation({ ip: null }, (tx, helpers) => Effect.flatMap(helpers.completeSignUp(tx, { profile: {}, authenticatedBy: "testMethod" }), () => Effect.die(new Error("after sign-up"))));
  await assert.rejects(a.run(failing), /after sign-up/);
  assert.equal(await count(accountsTables.accounts), 1);
  assert.equal(await count(coreTables.sessions), 1);
});

test("the session route answers the caller's session and account, and 401 codes otherwise", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const body = await expectJson(await a.call("session", { headers: a.bearer(bundle) }), 200);
  assert.equal(body.account.id, bundle.userId);
  assert.equal(body.sessionId, decodeJwt(bundle.accessToken).sub);
  assert.deepEqual(body.account.roles, ["customer"]);
  assert.equal((await expectJson(await a.call("session"), 401)).code, "not_signed_in");
  await a.run(a.auth.core.signOut({ ip: null }, { refreshToken: bundle.refreshToken }));
  assert.equal((await expectJson(await a.call("session", { headers: a.bearer(bundle) }), 401)).code, "not_signed_in");
});

test("refresh rotates; the same issued token again within the grace returns a second bundle", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const first = await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: bundle.refreshToken } }), 200);
  assert.equal(first.kind, "rotated");
  assert.notEqual(first.tokens.refreshToken, bundle.refreshToken);
  const again = await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: bundle.refreshToken } }), 200);
  assert.equal(again.kind, "rotated");
  assert.notEqual(again.tokens.refreshToken, first.tokens.refreshToken);
  assert.equal((await expectJson(await a.call("session", { headers: a.bearer(first.tokens) }), 200)).account.id, bundle.userId);
});

test("a spent refresh token ends the session, and the access token minted before it stops authenticating", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const first = (await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: bundle.refreshToken } }), 200)).tokens;
  const second = (await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: first.refreshToken } }), 200)).tokens;
  assert.equal((await a.call("session", { headers: a.bearer(second) })).status, 200);
  // The first token is now spent.
  a.clock.now += 60_000;
  assert.equal((await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: bundle.refreshToken } }), 200)).kind, "noSession");
  for (const stale of [bundle, first, second]) assert.equal((await a.call("session", { headers: a.bearer(stale) })).status, 401);
});

test("a malformed refresh token is 400 invalid_token and a missing one is too", async (t) => {
  const a = await compose(t);
  assert.equal((await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: "short" } }), 400)).code, "invalid_token");
  assert.equal((await expectJson(await a.call("session/refresh", { method: "POST", body: { refreshToken: 42 } }), 400)).code, "invalid_token");
  assert.equal((await expectJson(await a.call("session/refresh", { method: "POST" }), 400)).code, "invalid_token");
});

test("the 101st session of one account evicts the least recently refreshed", async (t) => {
  const a = await compose(t, { now: Date.parse("2026-01-01T00:00:00Z") });
  const first = await a.signUp();
  const bundles = [first];
  for (let i = 1; i < 101; i++) {
    a.clock.now += 1000;
    bundles.push(await a.run(a.method.signIn(first.userId)));
  }
  const sessions = await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(coreTables.sessions).collect()));
  assert.equal(sessions.length, 100);
  // The very first session refreshed longest ago and is the one gone.
  assert.equal((await a.call("session", { headers: a.bearer(first) })).status, 401);
  assert.equal((await a.call("session", { headers: a.bearer(bundles[100]) })).status, 200);
});

test("GET /auth/jwks lists one ES256 key; an access token verifies against it with sub the session id", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const response = await a.call("jwks");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const { keys } = await expectJson(response, 200);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].alg, "ES256");
  assert.ok(keys[0].kid);
  assert.equal(keys[0].d, undefined);
  const { payload, protectedHeader } = await jwtVerify(bundle.accessToken, createLocalJWKSet({ keys }), { issuer: a.auth.keys.issuer(), audience: "zelavis-auth", currentDate: new Date(a.clock.now) });
  assert.equal(protectedHeader.kid, keys[0].kid);
  const [session] = await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(coreTables.sessions).collect()));
  assert.equal(payload.sub, session._id);
  assert.match(a.auth.keys.issuer(), /^zelavis:platform:[0-9a-f]{32}$/);
});

test("rotating the key lists two, both verify; a retired key goes after the longest token lifetime, and no stored row holds a plain private key", async (t) => {
  const a = await compose(t);
  const before = await a.signUp();
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, before.userId, { permissions: ["system.settings.manage"] })));
  const { kid } = await expectJson(await a.call("keys/rotate", { method: "POST", headers: a.bearer(before) }), 200);
  const after = await a.run(a.method.signIn(before.userId));
  const { keys } = await expectJson(await a.call("jwks"), 200);
  assert.equal(keys.length, 2);
  assert.ok(keys.some((key) => key.kid === kid));
  const set = createLocalJWKSet({ keys });
  const verify = (token) => jwtVerify(token, set, { issuer: a.auth.keys.issuer(), audience: "zelavis-auth", currentDate: new Date(a.clock.now) });
  assert.notEqual((await verify(before.accessToken)).protectedHeader.kid, (await verify(after.accessToken)).protectedHeader.kid);
  // Both tokens keep authenticating through the route.
  assert.equal((await a.call("session", { headers: a.bearer(before) })).status, 200);
  assert.equal((await a.call("session", { headers: a.bearer(after) })).status, 200);
  const rows = await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(keysTables.signingKeys).collect()));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(JSON.stringify(row).includes('"d"'), false);
    assert.equal(row.publicJwk.d, undefined);
    assert.ok(row.sealedPrivateJwk.ciphertext);
  }
  a.clock.now += 3600 * 1000 + 1;
  const sweepKeys = a.auth.keys.sweeps[0];
  assert.equal(await a.run(sweepKeys.run(a.auth.runtime)), 1);
  assert.equal((await expectJson(await a.call("jwks"), 200)).keys.length, 1);
});

test("rotating the key without system.settings.manage is 403, and without a session 401", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  assert.equal((await a.call("keys/rotate", { method: "POST", headers: a.bearer(bundle) })).status, 403);
  assert.equal((await a.call("keys/rotate", { method: "POST" })).status, 401);
});

test("the authenticator yields the principal from a bearer header or the access cookie", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, bundle.userId, { roles: ["operator"], permissions: ["system.users.manage"], grants: [{ permission: "project.view", scope: { type: "project", projectId: "p1" } }] })));
  const viaBearer = await a.run(a.auth.authenticate(new Request(ORIGIN, { headers: a.bearer(bundle) })));
  const viaCookie = await a.run(a.auth.authenticate(new Request(ORIGIN, { headers: { cookie: `zelavis_access=${bundle.accessToken}` } })));
  for (const principal of [viaBearer, viaCookie]) {
    assert.equal(principal.id, bundle.userId);
    assert.equal(principal.type, "user");
    assert.deepEqual(principal.roles, ["operator"]);
    assert.deepEqual(principal.permissions, ["system.users.manage"]);
    assert.deepEqual(principal.grants, [{ permission: "project.view", scope: { type: "project", projectId: "p1" } }]);
    assert.equal(principal.metadata.sessionId, decodeJwt(bundle.accessToken).sub);
  }
  assert.equal(viaBearer.metadata.authenticationTransport, "bearer");
  assert.equal(viaCookie.metadata.authenticationTransport, "cookie");
});

test("an App runtime's principal holds its permissions as Project grants, never runtime-wide", async (t) => {
  const a = await compose(t, { role: "project", projectId: "site-é" });
  const bundle = await a.signUp();
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, bundle.userId, { permissions: ["project.data.read"] })));
  const principal = await a.run(a.auth.authenticate(new Request(ORIGIN, { headers: a.bearer(bundle) })));
  assert.equal(principal.permissions, undefined);
  assert.deepEqual(principal.grants, [{ permission: "project.data.read", scope: { type: "project", projectId: "site-é" } }]);
  assert.equal(principal.metadata.projectId, "site-é");
  assert.equal(a.auth.keys.issuer(), "zelavis:project:site-é");
});

test("the authenticator refuses a wrong audience, another runtime's key and an expired token; an expired one is marked", async (t) => {
  const a = await compose(t);
  const other = await compose(t);
  const bundle = await a.signUp();
  const foreign = await other.signUp();
  const request = (token) => new Request(ORIGIN, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await a.run(a.auth.authenticate(request(bundle.accessToken))) !== undefined, true);
  // Another runtime's key signs a perfectly shaped token: no principal here.
  assert.equal(await a.run(a.auth.authenticate(request(foreign.accessToken))), undefined);
  // The right key and issuer, a wrong audience.
  const [{ kid }] = (await a.run(a.auth.keys.jwks())).keys;
  const { key } = await privateKeyOf(a, kid);
  const sub = decodeJwt(bundle.accessToken).sub;
  const issuedAt = Math.floor(a.clock.now / 1000);
  const forged = (audience) => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid }).setSubject(sub).setIssuer(a.auth.keys.issuer()).setAudience(audience).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 300).sign(key);
  assert.equal(await a.run(a.auth.authenticate(request(await forged("foreign-auth")))), undefined);
  assert.notEqual(await a.run(a.auth.authenticate(request(await forged("zelavis-auth")))), undefined);
  // Not a JWT at all, and an unsigned one.
  assert.equal(await a.run(a.auth.authenticate(request("zvs_not_ours"))), undefined);
  assert.equal(await a.run(a.auth.authenticate(request(`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub, aud: "zelavis-auth" })).toString("base64url")}.`))), undefined);
  // Expired: no principal, and the route says why.
  a.clock.now += 301 * 1000;
  const expired = new Request(`${ORIGIN}/auth/session`, { headers: { authorization: `Bearer ${bundle.accessToken}` } });
  assert.equal(await a.run(a.auth.authenticate(expired)), undefined);
  assert.equal(a.auth.authenticator.expiredToken(expired), true);
  const response = await a.call("session", { headers: a.bearer(bundle) });
  assert.equal((await expectJson(response, 401)).code, "access_token_expired");
});

test("refreshing with the refresh cookie sets both cookies on their own paths and returns no tokens; sign-out clears them", async (t) => {
  const a = await compose(t, { apiBase: "/zelavis/api/v1" });
  const bundle = await a.signUp();
  const headers = { cookie: `zelavis_refresh=${bundle.refreshToken}`, origin: ORIGIN };
  const response = await a.call("session/refresh", { method: "POST", headers });
  const body = await expectJson(response, 200);
  assert.equal(body.kind, "rotated");
  assert.equal(body.tokens, undefined);
  assert.equal(JSON.stringify(body).includes("accessToken"), false);
  assert.equal(JSON.stringify(body).includes("refreshToken\""), false);
  const lines = cookieLines(response);
  assert.equal(lines.length, 2);
  const access = lines.find((line) => line.startsWith("zelavis_access="));
  const refresh = lines.find((line) => line.startsWith("zelavis_refresh="));
  assert.match(access, /^zelavis_access=[\w-]+\.[\w-]+\.[\w-]+; Path=\/zelavis\/api\/v1; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/);
  assert.match(refresh, /^zelavis_refresh=[\w-]{43}; Path=\/zelavis\/api\/v1\/auth\/session; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/);
  // The cookie's access token authenticates.
  const token = access.split(";")[0].split("=")[1];
  assert.equal((await a.call("session", { headers: { cookie: `zelavis_access=${token}` } })).status, 200);
  // A refresh cookie that is unknown clears both cookies.
  const unknown = await a.call("session/refresh", { method: "POST", headers: { cookie: `zelavis_refresh=${"A".repeat(43)}`, origin: ORIGIN } });
  assert.equal((await expectJson(unknown, 200)).kind, "noSession");
  assert.equal(cookieLines(unknown).every((line) => /Max-Age=0/.test(line)), true);
  // Sign-out with the refresh cookie ends the session and clears the cookies.
  const newRefresh = refresh.split(";")[0].split("=")[1];
  const out = await a.call("session", { method: "DELETE", headers: { cookie: `zelavis_refresh=${newRefresh}`, origin: ORIGIN } });
  assert.equal(out.status, 204);
  const cleared = cookieLines(out);
  assert.equal(cleared.length, 2);
  assert.ok(cleared.some((line) => line.startsWith("zelavis_access=; Path=/zelavis/api/v1;") && /Max-Age=0/.test(line)));
  assert.ok(cleared.some((line) => line.startsWith("zelavis_refresh=; Path=/zelavis/api/v1/auth/session;") && /Max-Age=0/.test(line)));
  assert.equal((await a.call("session", { headers: { cookie: `zelavis_access=${token}` } })).status, 401);
});

test("cookies are Secure only on https and a cross-origin cookie request is refused", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  const plain = await a.call("session/refresh", { method: "POST", origin: "http://localhost:3000", headers: { cookie: `zelavis_refresh=${bundle.refreshToken}`, origin: "http://localhost:3000" } });
  assert.equal(plain.status, 200);
  assert.equal(cookieLines(plain).some((line) => /Secure/.test(line)), false);
  const cross = await a.call("session/refresh", { method: "POST", headers: { cookie: `zelavis_refresh=${bundle.refreshToken}`, origin: "https://evil.example" } });
  assert.equal((await expectJson(cross, 403)).code, "forbidden");
  assert.equal((await a.call("session", { method: "DELETE", headers: { cookie: `zelavis_refresh=${bundle.refreshToken}`, origin: "https://evil.example" } })).status, 403);
});

test("an App runtime names its cookies after the Project's session audience", async (t) => {
  const a = await compose(t, { role: "project", projectId: "site-é" });
  const bundle = await a.signUp();
  const { createHash } = await import("node:crypto");
  const audience = createHash("sha256").update("site-é").digest("hex").slice(0, 24);
  const response = await a.call("session/refresh", { method: "POST", headers: { cookie: `zelavis_app_${audience}_refresh=${bundle.refreshToken}`, origin: ORIGIN } });
  assert.equal(response.status, 200);
  const lines = cookieLines(response);
  assert.ok(lines.some((line) => line.startsWith(`zelavis_app_${audience}=`)));
  assert.ok(lines.some((line) => line.startsWith(`zelavis_app_${audience}_refresh=`)));
});

test("sessions: list marks the current one, revoke ends the caller's own, revoke-others ends the rest, a foreign session reads as absent", async (t) => {
  const a = await compose(t);
  const first = await a.signUp();
  const second = await a.run(a.method.signIn(first.userId));
  const stranger = await a.signUp();
  const list = await expectJson(await a.call("sessions", { headers: a.bearer(first) }), 200);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((s) => s.current).sort(), [false, true]);
  assert.equal(list.find((s) => s.current).sessionId, decodeJwt(first.accessToken).sub);
  assert.equal((await a.call(`sessions/${decodeJwt(stranger.accessToken).sub}`, { method: "DELETE", headers: a.bearer(first) })).status, 404);
  assert.equal((await a.call("session", { headers: a.bearer(stranger) })).status, 200);
  const third = await a.run(a.method.signIn(first.userId));
  assert.deepEqual(await expectJson(await a.call("sessions/revoke-others", { method: "POST", headers: a.bearer(first) }), 200), { revoked: 2 });
  assert.equal((await a.call("session", { headers: a.bearer(second) })).status, 401);
  assert.equal((await a.call("session", { headers: a.bearer(third) })).status, 401);
  assert.equal((await a.call("session", { headers: a.bearer(first) })).status, 200);
  const fourth = await a.run(a.method.signIn(first.userId));
  assert.equal((await a.call(`sessions/${decodeJwt(fourth.accessToken).sub}`, { method: "DELETE", headers: a.bearer(first) })).status, 204);
  assert.equal((await a.call("session", { headers: a.bearer(fourth) })).status, 401);
  assert.equal((await a.call("sessions")).status, 401);
});

test("start runs the sweeps and stop ends them", async (t) => {
  const a = await compose(t);
  const bundle = await a.signUp();
  await a.run(a.auth.core.signOut({ ip: null }, { refreshToken: bundle.refreshToken }));
  assert.equal((await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(coreTables.refreshTokens).collect()))).length, 1);
  const running = await a.run(a.auth.start());
  const deadline = Date.now() + 5000;
  let remaining = 1;
  while (remaining > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = (await a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(coreTables.refreshTokens).collect()))).length;
  }
  await a.run(running.stop());
  assert.equal(remaining, 0);
});
