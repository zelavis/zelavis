/**
 * Zelavis Auth core: sessions, refresh tokens, signing keys, the accounts module and the authenticator.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Cause, Effect, Exit } from "effect";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { createOrphanTokensSweep, STANDARD_ISSUED_REFRESH_TOKEN_LIMIT, REFRESH_GRACE_MS, SPENT_TOKEN_HORIZON_MS, MAX_SESSIONS_PER_USER } from "../dist/auth/core/sessions.js";
import * as core_ from "../dist/auth/core/public.js";
import { getAuthUserId } from "../dist/auth/core/userId.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, DEFAULT_SESSION_MAX_LIFETIME_SECONDS, resolveTtlConfig } from "../dist/auth/lib/ttl.js";
import { sha256Hex } from "../dist/auth/lib/crypto.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { bindTestMethod, openAuth } from "./_auth.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_TTL = resolveTtlConfig({});
const ttl = (overrides = {}) => resolveTtlConfig(overrides);
const claims = (overrides = {}) => ({ method: "usernamePassword", profile: { name: "Alice" }, ...overrides });
const COMPONENT_PATH = "authPassword";

/** The spy the upstream fixture (`testApp.fixture.ts`) is: createUser mints `user<n>`, onSignIn records. */
function fixture() {
  const calls = { createUser: [], onSignIn: [] };
  return {
    calls,
    createUser: (_tx, args) => { calls.createUser.push({ ...args }); return Effect.succeed(`user${calls.createUser.length}`); },
    onSignIn: (_tx, args) => { calls.onSignIn.push({ ...args }); return Effect.void; },
    onSignInThatThrows: () => Effect.die(new Error("no sign-ins for you")),
  };
}

async function open(t, options) {
  const opened = await openAuth(t, options);
  const spy = fixture();
  const { core, run, clock } = opened;
  const mutation = (body) => run(core.mutation({ ip: null }, body));
  const query = (body) => run(core.query({ ip: null }, body));
  const defect = async (effect) => {
    const exit = await Effect.runPromise(Effect.exit(effect));
    assert.ok(Exit.isFailure(exit), "expected the effect to fail");
    return Cause.squash(exit.cause);
  };
  const api = {
    ...opened,
    spy,
    mutation,
    query,
    defect,
    signUp: (c = claims(), extra = {}) => mutation((tx) => core_._internal_dangerous_signUp(tx, { claims: c, componentPath: COMPONENT_PATH, createUser: spy.createUser, onSignIn: spy.onSignIn, ...DEFAULT_TTL, ...extra })),
    signIn: (c, userId, extra = {}) => mutation((tx) => core_._internal_dangerous_signIn(tx, { claims: c, componentPath: COMPONENT_PATH, userId, onSignIn: spy.onSignIn, ...DEFAULT_TTL, ...extra })),
    refresh: (refreshToken, lifetimes = DEFAULT_TTL) => mutation((tx) => core_.refresh(tx, { refreshToken, ...lifetimes })),
    signOut: (refreshToken) => mutation((tx) => core_.signOut(tx, { refreshToken })),
    listSessions: (userId) => query((tx) => core_.listSessions(tx, { userId })),
    getSession: (sessionId) => query((tx) => core_.getSession(tx, { sessionId })),
    revokeSessions: (sessionIds) => mutation((tx) => core_.revokeSessions(tx, { sessionIds })),
    sessions: () => query((tx) => tx.db.query(coreTables.sessions).collect()),
    sessionCount: async () => (await query((tx) => tx.db.query(coreTables.sessions).collect())).length,
    tokensInState: async (...states) => (await query((tx) => tx.db.query(coreTables.refreshTokens).collect())).filter((r) => states.includes(r.state)),
    sweep: () => run(createOrphanTokensSweep(opened.tenant).run(opened.auth.runtime)),
    verifyAccessToken: async (token) => jwtVerify(token, createLocalJWKSet(await run(opened.auth.keys.jwks())), { issuer: opened.auth.keys.issuer(), audience: "zelavis-auth", currentDate: new Date(clock.now) }),
  };
  api.retiredHashes = async () => (await api.tokensInState("spent", "dropped")).map((r) => r.hash);
  api.retiredTokens = async () => (await api.tokensInState("spent", "dropped")).map((r) => ({ hash: r.hash, state: r.state }));
  api.issuedHashes = async () => (await api.tokensInState("issued")).map((r) => r.hash);
  api.redeemedHash = async () => {
    const redeemed = await api.tokensInState("redeemed");
    assert.ok(redeemed.length <= 1);
    return redeemed[0]?.hash;
  };
  return api;
}

const expectRotated = (result) => {
  assert.equal(result.kind, "rotated");
  return result.tokens;
};
const sessionIdOf = (bundle) => decodeJwt(bundle.accessToken).sub;
const START = Date.parse("2026-01-01T00:00:00Z");

test("upstream: a session records the path of the component that authenticated the user", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const { payload } = await a.verifyAccessToken(bundle.accessToken);
  const session = await a.query((tx) => tx.db.get(coreTables.sessions, payload.sub));
  assert.equal(session.component, COMPONENT_PATH);
});

test("upstream: signUp, signIn, and signUpWithoutSession record the user ID once", async (t) => {
  const a = await open(t);
  const { userId } = await a.signUp();
  await a.signIn(claims(), userId);
  await a.signIn(claims(), "someone");
  const { userId: pending } = await a.mutation((tx) => core_._internal_dangerous_signUpWithoutSession(tx, { claims: claims(), createUser: a.spy.createUser }));
  const created = (await a.query((tx) => tx.db.query(coreTables.createdUserIds).collect())).map((row) => row.userId);
  assert.deepEqual(created.sort(), [userId, "someone", pending].sort());
});

test("upstream: markUserIdCreated records a user ID once, and refuses an empty one", async (t) => {
  const a = await open(t);
  await a.mutation((tx) => core_.markUserIdCreated(tx, { userId: "imported" }));
  await a.mutation((tx) => core_.markUserIdCreated(tx, { userId: "imported" }));
  assert.deepEqual((await a.query((tx) => tx.db.query(coreTables.createdUserIds).collect())).map((row) => row.userId), ["imported"]);
  assert.match((await a.defect(a.core.mutation({ ip: null }, (tx) => core_.markUserIdCreated(tx, { userId: "" })))).message, /empty user ID/);
});

test("upstream: signUp creates a session and mints a verifiable JWT", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.ok(bundle.userId);
  assert.ok(bundle.refreshToken);
  const [session] = await a.sessions();
  assert.equal(session.userId, bundle.userId);
  assert.equal(session.component, COMPONENT_PATH);
  const { payload } = await a.verifyAccessToken(bundle.accessToken);
  // The subject is the session, not the user: the runtime resolves the user through the session.
  assert.equal(payload.sub, session._id);
  assert.ok(payload.exp * 1000 > a.clock.now);
  assert.ok(bundle.refreshTokenExpiresAt > payload.exp * 1000);
});

test("upstream: signUp invokes the createUser with the claims, then onSignIn", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp(claims({ profile: { name: "Alice" } }));
  assert.deepEqual(a.spy.calls.createUser, [{ method: { name: "usernamePassword", profile: { name: "Alice" } } }]);
  // A first sign-in is still a sign-in, so onSignIn runs too, with the id createUser just returned.
  assert.deepEqual(a.spy.calls.onSignIn, [{ method: { name: "usernamePassword", profile: { name: "Alice" } }, userId: bundle.userId }]);
});

test("upstream: signUp creates the user without an onSignIn attached", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp(claims(), { onSignIn: undefined });
  assert.equal(bundle.userId, "user1");
  assert.equal(a.spy.calls.createUser.length, 1);
  assert.equal(a.spy.calls.onSignIn.length, 0);
});

test("upstream: an onSignIn that throws rolls back the user it just created", async (t) => {
  const a = await open(t);
  const failure = await a.defect(a.core.mutation({ ip: null }, (tx) => core_._internal_dangerous_signUp(tx, { claims: claims(), componentPath: COMPONENT_PATH, createUser: a.spy.createUser, onSignIn: a.spy.onSignInThatThrows, ...DEFAULT_TTL })));
  assert.match(failure.message, /no sign-ins for you/);
  assert.equal(await a.sessionCount(), 0);
  // Here the account row is in the same transaction too, so it rolls back with the rest.
  const none = await a.core.mutation({ ip: null }, (tx) => core_._internal_dangerous_signUp(tx, { claims: claims(), componentPath: COMPONENT_PATH, createUser: a.auth.accounts.createUser, onSignIn: a.spy.onSignInThatThrows, ...DEFAULT_TTL })).pipe(Effect.exit, Effect.runPromise);
  assert.ok(Exit.isFailure(none));
  assert.equal((await a.query((tx) => tx.db.query(accountsTables.accounts).collect())).length, 0);
  assert.equal((await a.query((tx) => tx.db.query(coreTables.createdUserIds).collect())).length, 0);
});

test("upstream: signIn mints a fresh session for the given user", async (t) => {
  const a = await open(t);
  const first = await a.signUp(claims({ profile: { name: "Alice" } }));
  const second = await a.signIn(claims({ profile: { name: "Alice 2.0" } }), first.userId);
  assert.equal(second.userId, first.userId);
  const sessions = await a.sessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(({ userId, component }) => ({ userId, component })), [
    { userId: first.userId, component: COMPONENT_PATH },
    { userId: first.userId, component: COMPONENT_PATH },
  ]);
});

test("upstream: signIn invokes the onSignIn with the resolved user id and latest claims", async (t) => {
  const a = await open(t);
  const first = await a.signUp(claims({ profile: { name: "Alice" } }));
  await a.signIn(claims({ profile: { name: "Alice 2.0" } }), first.userId);
  assert.equal(a.spy.calls.createUser.length, 1);
  assert.equal(a.spy.calls.onSignIn.length, 2);
  assert.deepEqual(a.spy.calls.onSignIn[1], { method: { name: "usernamePassword", profile: { name: "Alice 2.0" } }, userId: first.userId });
});

test("upstream: signIn mints the session without notifying a method that attached no onSignIn", async (t) => {
  const a = await open(t);
  const first = await a.signUp();
  a.spy.calls.onSignIn.length = 0;
  const bundle = await a.signIn(claims(), first.userId, { onSignIn: undefined });
  assert.equal(bundle.userId, first.userId);
  assert.equal(a.spy.calls.onSignIn.length, 0);
});

test("upstream: signIn refuses an empty user id", async (t) => {
  const a = await open(t);
  assert.match((await a.defect(a.core.mutation({ ip: null }, (tx) => core_._internal_dangerous_signIn(tx, { claims: claims(), componentPath: COMPONENT_PATH, userId: "", onSignIn: a.spy.onSignIn, ...DEFAULT_TTL })))).message, /no user id/i);
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: signUpWithoutSession creates the user, but no session", async (t) => {
  const a = await open(t);
  const { userId } = await a.mutation((tx) => core_._internal_dangerous_signUpWithoutSession(tx, { claims: claims(), createUser: a.spy.createUser }));
  assert.equal(userId, "user1");
  assert.equal(a.spy.calls.createUser.length, 1);
  assert.equal(a.spy.calls.onSignIn.length, 0);
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: a later signIn with the user id mints a session", async (t) => {
  const a = await open(t);
  const { userId } = await a.mutation((tx) => core_._internal_dangerous_signUpWithoutSession(tx, { claims: claims(), createUser: a.spy.createUser }));
  const bundle = await a.signIn(claims(), userId);
  assert.equal(bundle.userId, userId);
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: refresh rotates the refresh token and mints a fresh access token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  assert.notEqual(rotated.refreshToken, bundle.refreshToken);
  assert.equal(rotated.userId, bundle.userId);
  const again = expectRotated(await a.refresh(rotated.refreshToken));
  assert.notEqual(again.refreshToken, rotated.refreshToken);
});

test("upstream: sign-in issues a token that its first refresh redeems", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.equal(await a.redeemedHash(), undefined);
  assert.deepEqual(await a.issuedHashes(), [await a.run(sha256Hex(bundle.refreshToken))]);
  const successor = expectRotated(await a.refresh(bundle.refreshToken));
  assert.equal(await a.redeemedHash(), await a.run(sha256Hex(bundle.refreshToken)));
  assert.deepEqual(await a.issuedHashes(), [await a.run(sha256Hex(successor.refreshToken))]);
  assert.deepEqual(await a.retiredHashes(), []);
});

test("upstream: a refresh whose response was lost can be retried with the same token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const lost = expectRotated(await a.refresh(bundle.refreshToken));
  const retry = expectRotated(await a.refresh(bundle.refreshToken));
  assert.notEqual(retry.refreshToken, lost.refreshToken);
  expectRotated(await a.refresh(retry.refreshToken));
  assert.equal(await a.sessionCount(), 1);
  assert.deepEqual(await a.retiredTokens(), [
    { hash: await a.run(sha256Hex(bundle.refreshToken)), state: "spent" },
    { hash: await a.run(sha256Hex(lost.refreshToken)), state: "dropped" },
  ]);
});

test("upstream: first use of an issued token redeems it and spends the one before", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const successor = expectRotated(await a.refresh(bundle.refreshToken));
  const next = expectRotated(await a.refresh(successor.refreshToken));
  assert.equal(await a.redeemedHash(), await a.run(sha256Hex(successor.refreshToken)));
  assert.deepEqual(await a.issuedHashes(), [await a.run(sha256Hex(next.refreshToken))]);
  assert.deepEqual(await a.retiredTokens(), [{ hash: await a.run(sha256Hex(bundle.refreshToken)), state: "spent" }]);
});

test("upstream: racers sharing the redeemed token each get an issued token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const racers = [];
  for (let i = 0; i < 3; i++) racers.push(expectRotated(await a.refresh(bundle.refreshToken)));
  assert.equal(new Set(racers.map((r) => r.refreshToken)).size, 3);
  expectRotated(await a.refresh(racers[2].refreshToken));
  assert.equal(await a.sessionCount(), 1);
  assert.equal((await a.retiredTokens()).filter((r) => r.state === "dropped").length, 2);
});

test("upstream: racers sharing an issued token both succeed", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const successor = expectRotated(await a.refresh(bundle.refreshToken));
  const first = expectRotated(await a.refresh(successor.refreshToken));
  const second = expectRotated(await a.refresh(successor.refreshToken));
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(await a.sessionCount(), 1);
  assert.equal(await a.redeemedHash(), await a.run(sha256Hex(successor.refreshToken)));
});

test("upstream: refresh reports no session and clears it once the refresh token has expired", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  const successor = expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 31 * DAY_MS;
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  assert.equal((await a.refresh(successor.refreshToken)).kind, "noSession");
});

test("upstream: refresh reports no session for an expired issued token", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  const successor = expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 31 * DAY_MS;
  assert.equal((await a.refresh(successor.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  await a.sweep();
  assert.deepEqual(await a.issuedHashes(), []);
});

test("upstream: a lowered inactivity timeout expires tokens issued under the old one", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  a.clock.now += 2 * HOUR_MS;
  const result = await a.refresh(bundle.refreshToken, ttl({ refreshInactivityTimeoutSeconds: 60 * 60 }));
  assert.equal(result.kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: a lowered inactivity timeout expires the redeemed token a retry would present", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 2 * HOUR_MS;
  const result = await a.refresh(bundle.refreshToken, ttl({ refreshInactivityTimeoutSeconds: 60 * 60 }));
  assert.equal(result.kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: refresh refuses a session past its max lifetime, however recently it refreshed", async (t) => {
  const a = await open(t, { now: START });
  const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 60 * 60, sessionMaxLifetimeSeconds: 2 * 60 * 60 });
  let bundle = await a.signUp(claims(), lifetimes);
  for (let i = 0; i < 3; i++) {
    a.clock.now += 30 * 60 * 1000;
    bundle = expectRotated(await a.refresh(bundle.refreshToken, lifetimes));
  }
  a.clock.now += 30 * 60 * 1000 + 1;
  const result = await a.refresh(bundle.refreshToken, lifetimes);
  assert.equal(result.kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: a lowered max lifetime ends a session created before the change", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  a.clock.now += 2 * HOUR_MS;
  const fresh = expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 60 * 1000;
  const result = await a.refresh(fresh.refreshToken, ttl({ sessionMaxLifetimeSeconds: 60 * 60 }));
  assert.equal(result.kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: a redeemed token's inactivity counts from the session's newest token", async (t) => {
  const a = await open(t, { now: START });
  const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 60 * 60 });
  const bundle = await a.signUp(claims(), lifetimes);
  a.clock.now += 50 * 60 * 1000;
  expectRotated(await a.refresh(bundle.refreshToken, lifetimes));
  a.clock.now += 20 * 60 * 1000;
  expectRotated(await a.refresh(bundle.refreshToken, lifetimes));
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: refresh reports no session for an unknown refresh token", async (t) => {
  const a = await open(t);
  assert.equal((await a.refresh("not-a-real-token")).kind, "noSession");
});

test("upstream: an unknown token revokes nothing", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.equal((await a.refresh("not-a-real-token")).kind, "noSession");
  assert.equal(await a.sessionCount(), 1);
  assert.ok(expectRotated(await a.refresh(bundle.refreshToken)));
});

test("upstream: a lost response is recoverable after any gap", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 2 * HOUR_MS;
  const recovered = expectRotated(await a.refresh(bundle.refreshToken));
  expectRotated(await a.refresh(recovered.refreshToken));
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: a spent token revokes the session", async (t) => {
  const a = await open(t, { now: START });
  const stolen = await a.signUp();
  const thief = expectRotated(await a.refresh(stolen.refreshToken));
  const thiefNext = expectRotated(await a.refresh(thief.refreshToken));
  a.clock.now += 60_000;
  assert.equal((await a.refresh(stolen.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  await a.sweep();
  assert.deepEqual(await a.retiredHashes(), []);
  assert.deepEqual(await a.issuedHashes(), []);
  // Revocation is mutual: the thief's token stops working too.
  assert.equal((await a.refresh(thiefNext.refreshToken)).kind, "noSession");
});

test("upstream: a dropped token revokes the session", async (t) => {
  const a = await open(t, { now: START });
  const stolen = await a.signUp();
  const victim = expectRotated(await a.refresh(stolen.refreshToken));
  const thief = expectRotated(await a.refresh(stolen.refreshToken));
  const victimNext = expectRotated(await a.refresh(victim.refreshToken));
  assert.equal((await a.refresh(thief.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  assert.equal((await a.refresh(victimNext.refreshToken)).kind, "noSession");
});

test("upstream: detects a replay several rotations back", async (t) => {
  const a = await open(t, { now: START });
  const stolen = await a.signUp();
  let latest = stolen;
  for (let i = 0; i < 6; i++) latest = expectRotated(await a.refresh(latest.refreshToken));
  assert.equal((await a.retiredHashes()).length, 5);
  a.clock.now += 60_000;
  assert.equal((await a.refresh(stolen.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  assert.equal((await a.refresh(latest.refreshToken)).kind, "noSession");
});

test("upstream: a replay after the session is already gone is a no-op", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  expectRotated(await a.refresh(rotated.refreshToken));
  await a.signOut(rotated.refreshToken);
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
});

test("upstream: pruning retires spent hashes, and with them the detection", async (t) => {
  const a = await open(t, { now: START });
  const stolen = await a.signUp();
  const live = expectRotated(await a.refresh(stolen.refreshToken));
  const next = expectRotated(await a.refresh(live.refreshToken));
  assert.deepEqual(await a.retiredHashes(), [await a.run(sha256Hex(stolen.refreshToken))]);
  a.clock.now += SPENT_TOKEN_HORIZON_MS + 1;
  const after = expectRotated(await a.refresh(next.refreshToken));
  assert.deepEqual(await a.retiredHashes(), [await a.run(sha256Hex(live.refreshToken))]);
  assert.equal((await a.refresh(stolen.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 1);
  expectRotated(await a.refresh(after.refreshToken));
});

test(`upstream: revokes the session at the standard limit of ${STANDARD_ISSUED_REFRESH_TOKEN_LIMIT} issued tokens`, async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
    expectRotated(await a.refresh(bundle.refreshToken));
    a.clock.now += REFRESH_GRACE_MS + 1;
  }
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
  assert.equal(await a.sessionCount(), 0);
  await a.sweep();
  assert.deepEqual(await a.issuedHashes(), []);
});

test("upstream: redeeming an issued token resets the count", async (t) => {
  const a = await open(t, { now: START });
  let token = (await a.signUp()).refreshToken;
  for (let round = 0; round < 3; round++) {
    let last;
    for (let i = 0; i < STANDARD_ISSUED_REFRESH_TOKEN_LIMIT; i++) {
      last = expectRotated(await a.refresh(token));
      a.clock.now += REFRESH_GRACE_MS + 1;
    }
    token = last.refreshToken;
  }
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: concurrent refreshes right after a redemption don't count", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  const burst = await Promise.all(Array.from({ length: STANDARD_ISSUED_REFRESH_TOKEN_LIMIT + 3 }, () => a.refresh(bundle.refreshToken)));
  burst.forEach(expectRotated);
  assert.equal(await a.sessionCount(), 1);
  a.clock.now += 60_000;
  expectRotated(await a.refresh(expectRotated(burst.at(-1)).refreshToken));
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: the grace doesn't extend past the redemption", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  expectRotated(await a.refresh(bundle.refreshToken));
  const results = [];
  for (let i = 0; i < 10; i++) {
    a.clock.now += REFRESH_GRACE_MS - 1000;
    const result = await a.refresh(bundle.refreshToken);
    results.push(result.kind);
    if (result.kind === "noSession") break;
  }
  assert.equal(results.at(-1), "noSession");
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: signOut revokes the session so it can no longer be refreshed", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  await a.signOut(bundle.refreshToken);
  assert.equal(await a.sessionCount(), 0);
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
});

test("upstream: signOut revokes when given an issued token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  await a.signOut(rotated.refreshToken);
  assert.equal(await a.sessionCount(), 0);
  await a.sweep();
  assert.deepEqual(await a.issuedHashes(), []);
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
});

test("upstream: signOut revokes when given a spent token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  const next = expectRotated(await a.refresh(rotated.refreshToken));
  await a.signOut(bundle.refreshToken);
  assert.equal(await a.sessionCount(), 0);
  await a.sweep();
  assert.deepEqual(await a.retiredHashes(), []);
  assert.equal((await a.refresh(next.refreshToken)).kind, "noSession");
});

test("upstream: signOut erases the session's refresh tokens along with it", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  const next = expectRotated(await a.refresh(rotated.refreshToken));
  assert.equal((await a.retiredHashes()).length, 1);
  assert.equal((await a.issuedHashes()).length, 1);
  await a.signOut(next.refreshToken);
  await a.sweep();
  assert.deepEqual(await a.retiredHashes(), []);
  assert.deepEqual(await a.issuedHashes(), []);
});

test("upstream: a token whose session is gone reports no session", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  const next = expectRotated(await a.refresh(rotated.refreshToken));
  await a.signOut(next.refreshToken);
  assert.equal((await a.issuedHashes()).length, 1);
  assert.equal((await a.refresh(next.refreshToken)).kind, "noSession");
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "noSession");
  assert.deepEqual(a.logs.filter((entry) => entry.level === "Warn"), []);
});

test("upstream: signOut is idempotent — signing out an already-revoked token does not throw", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  await a.signOut(bundle.refreshToken);
  assert.equal(await a.signOut(bundle.refreshToken), null);
});

test("upstream: listSessions lists every session of the user", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const other = await a.signIn(claims(), bundle.userId);
  const sessions = await a.listSessions(bundle.userId);
  assert.deepEqual(sessions.map((s) => s.sessionId).sort(), [sessionIdOf(bundle), sessionIdOf(other)].sort());
});

test("upstream: listSessions lists the newest session first", async (t) => {
  const a = await open(t);
  const first = await a.signUp();
  const second = await a.signIn(claims(), first.userId);
  const third = await a.signIn(claims(), first.userId);
  assert.deepEqual((await a.listSessions(first.userId)).map((s) => s.sessionId), [third, second, first].map(sessionIdOf));
});

test("upstream: listSessions lists only the sessions of the given user", async (t) => {
  const a = await open(t);
  const alice = await a.signUp();
  await a.signUp(claims({ profile: { name: "Bob" } }));
  assert.deepEqual((await a.listSessions(alice.userId)).map((s) => s.sessionId), [sessionIdOf(alice)]);
});

test("upstream: listSessions reports when the session's newest refresh token was issued", async (t) => {
  const a = await open(t, { now: START });
  const bundle = await a.signUp();
  a.clock.now += 60_000;
  const refreshedAt = a.clock.now;
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  const sessions = await a.listSessions(bundle.userId);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionIdOf(rotated));
  assert.equal(typeof sessions[0].creationTime, "number");
  assert.equal(sessions[0].lastRefreshedAt, refreshedAt);
});

test("upstream: listSessions includes a session whose refresh tokens have all expired", async (t) => {
  const a = await open(t, { now: START });
  const stale = await a.signUp();
  a.clock.now += 31 * DAY_MS;
  const fresh = await a.signIn(claims(), stale.userId);
  assert.deepEqual((await a.listSessions(stale.userId)).map((s) => s.sessionId), [fresh, stale].map(sessionIdOf));
});

test("upstream: no token outlives one inactivity timeout past the session's lastRefreshedAt", async (t) => {
  const a = await open(t, { now: START });
  const oneHourSeconds = 60 * 60;
  const bundle = await a.signUp();
  expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 60_000;
  const older = expectRotated(await a.refresh(bundle.refreshToken));
  a.clock.now += 60_000;
  expectRotated(await a.refresh(bundle.refreshToken, ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds })));
  const [listed] = await a.listSessions(bundle.userId);
  assert.equal(Math.floor(listed.lastRefreshedAt), a.clock.now);
  a.clock.now = Math.ceil(listed.lastRefreshedAt + oneHourSeconds * 1000);
  const result = await a.refresh(older.refreshToken, ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds }));
  assert.equal(result.kind, "noSession");
});

test("upstream: listSessions leaves out, with a warning, a session with no issued token", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const other = await a.signIn(claims(), bundle.userId);
  await a.mutation((tx) => Effect.gen(function* () {
    const tokens = yield* tx.db.query(coreTables.refreshTokens).withIndex("by_session_state", (q) => q.eq("sessionId", sessionIdOf(other))).collect();
    for (const row of tokens) yield* tx.db.delete(coreTables.refreshTokens, row._id);
  }));
  const sessions = await a.listSessions(bundle.userId);
  assert.deepEqual(sessions.map((s) => s.sessionId), [sessionIdOf(bundle)]);
  assert.ok(a.logs.some((entry) => entry.level === "Warn" && entry.text.includes("has no issued refresh token")));
});

test("upstream: listSessions returns nothing for a user with no sessions", async (t) => {
  const a = await open(t);
  assert.deepEqual(await a.listSessions("nobody"), []);
});

/** Sign the user in until they have `count` sessions, a second apart. */
async function signInUntil(a, count) {
  const bundles = [await a.signUp()];
  while (bundles.length < count) {
    a.clock.now += 1000;
    bundles.push(await a.signIn(claims(), bundles[0].userId));
  }
  return bundles;
}

test(`upstream: the cap of ${MAX_SESSIONS_PER_USER} sessions per user keeps every session up to the cap`, async (t) => {
  const a = await open(t, { now: START });
  await signInUntil(a, MAX_SESSIONS_PER_USER);
  assert.equal(await a.sessionCount(), MAX_SESSIONS_PER_USER);
});

test("upstream: a sign-in at the cap revokes the session that refreshed longest ago", async (t) => {
  const a = await open(t, { now: START });
  const [first, second, third] = await signInUntil(a, MAX_SESSIONS_PER_USER);
  a.clock.now += 1000;
  expectRotated(await a.refresh(first.refreshToken));
  a.clock.now += 1000;
  const newest = await a.signIn(claims(), first.userId);
  assert.equal(await a.sessionCount(), MAX_SESSIONS_PER_USER);
  const listed = (await a.listSessions(first.userId)).map((s) => s.sessionId);
  assert.ok(!listed.includes(sessionIdOf(second)));
  assert.ok(listed.includes(sessionIdOf(first)));
  assert.ok(listed.includes(sessionIdOf(third)));
  assert.ok(listed.includes(sessionIdOf(newest)));
  assert.equal((await a.refresh(second.refreshToken)).kind, "noSession");
});

test("upstream: the cap erases the revoked session's refresh tokens", async (t) => {
  const a = await open(t, { now: START });
  const [first] = await signInUntil(a, MAX_SESSIONS_PER_USER);
  await a.signIn(claims(), first.userId);
  await a.sweep();
  const remaining = await a.query((tx) => tx.db.query(coreTables.refreshTokens).withIndex("by_session_state", (q) => q.eq("sessionId", sessionIdOf(first))).collect());
  assert.deepEqual(remaining, []);
});

test("upstream: a user over the cap is brought back to it", async (t) => {
  const a = await open(t, { now: START });
  const bundles = await signInUntil(a, MAX_SESSIONS_PER_USER);
  await a.mutation((tx) => Effect.gen(function* () {
    for (let i = 0; i < 2; i++) {
      const sessionId = yield* tx.db.insert(coreTables.sessions, { userId: bundles[0].userId, component: COMPONENT_PATH });
      yield* tx.db.insert(coreTables.refreshTokens, { hash: `extra-${i}`, sessionId, state: "issued" });
    }
  }));
  a.clock.now += 1000;
  const newest = await a.signIn(claims(), bundles[0].userId);
  assert.equal(await a.sessionCount(), MAX_SESSIONS_PER_USER);
  const listed = (await a.listSessions(newest.userId)).map((s) => s.sessionId);
  assert.ok(!listed.includes(sessionIdOf(bundles[0])));
  assert.ok(!listed.includes(sessionIdOf(bundles[1])));
  assert.ok(!listed.includes(sessionIdOf(bundles[2])));
  assert.ok(listed.includes(sessionIdOf(newest)));
});

test("upstream: the cap counts only the user's own sessions", async (t) => {
  const a = await open(t, { now: START });
  const bob = await a.signUp(claims({ profile: { name: "Bob" } }));
  const [first] = await signInUntil(a, MAX_SESSIONS_PER_USER);
  await a.signIn(claims(), first.userId);
  assert.equal((await a.listSessions(bob.userId)).length, 1);
  assert.equal((await a.listSessions(first.userId)).length, MAX_SESSIONS_PER_USER);
});

test("upstream: revokeSessions revokes the sessions so they can no longer be refreshed", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const second = await a.signIn(claims(), bundle.userId);
  const third = await a.signIn(claims(), bundle.userId);
  const revoked = await a.revokeSessions([sessionIdOf(second), sessionIdOf(third)]);
  assert.deepEqual([...revoked].sort(), [sessionIdOf(second), sessionIdOf(third)].sort());
  assert.equal(await a.sessionCount(), 1);
  assert.equal((await a.refresh(second.refreshToken)).kind, "noSession");
  assert.equal((await a.refresh(third.refreshToken)).kind, "noSession");
  assert.equal((await a.refresh(bundle.refreshToken)).kind, "rotated");
});

test("upstream: revokeSessions revokes the sessions of any user", async (t) => {
  const a = await open(t);
  const alice = await a.signUp();
  const bob = await a.signUp(claims({ profile: { name: "Bob" } }));
  assert.equal((await a.revokeSessions([sessionIdOf(alice), sessionIdOf(bob)])).length, 2);
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: revokeSessions erases the sessions' refresh tokens", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  expectRotated(await a.refresh(bundle.refreshToken));
  await a.revokeSessions([sessionIdOf(bundle)]);
  await a.sweep();
  assert.deepEqual(await a.query((tx) => tx.db.query(coreTables.refreshTokens).collect()), []);
});

test("the orphan sweep removes at most a batch a run, and the rest on the next run", async (t) => {
  const a = await open(t, { now: START });
  const bundles = [await a.signUp()];
  for (let i = 1; i < 6; i++) bundles.push(await a.signIn(claims(), bundles[0].userId));
  // 6 sessions with 60 extra spent tokens each: 366 token rows once the sessions are gone.
  for (const bundle of bundles) {
    await a.mutation((tx) => Effect.gen(function* () {
      for (let i = 0; i < 60; i++) yield* tx.db.insert(coreTables.refreshTokens, { hash: `${sessionIdOf(bundle)}-${i}`, sessionId: sessionIdOf(bundle), state: "spent", retiredAt: a.clock.now });
    }));
  }
  assert.equal((await a.revokeSessions(bundles.map(sessionIdOf))).length, 6);
  assert.equal(await a.sessionCount(), 0);
  const total = (await a.query((tx) => tx.db.query(coreTables.refreshTokens).collect())).length;
  assert.equal(total, 366);
  const first = await a.sweep();
  assert.equal(first, 200);
  assert.equal((await a.query((tx) => tx.db.query(coreTables.refreshTokens).collect())).length, 166);
  // Another run's sweep object starts at the beginning of the table and finishes the rest.
  assert.equal(await a.sweep(), 166);
  assert.deepEqual(await a.query((tx) => tx.db.query(coreTables.refreshTokens).collect()), []);
});

test("the orphan sweep keeps the tokens of live sessions", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const other = await a.signUp(claims({ profile: { name: "Bob" } }));
  await a.signOut(other.refreshToken);
  assert.equal(await a.sweep(), 1);
  assert.deepEqual(await a.issuedHashes(), [await a.run(sha256Hex(bundle.refreshToken))]);
});

test("upstream: revokeSessions skips an already-revoked session id", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const other = await a.signIn(claims(), bundle.userId);
  await a.signOut(bundle.refreshToken);
  assert.deepEqual(await a.revokeSessions([sessionIdOf(bundle), sessionIdOf(other)]), [sessionIdOf(other)]);
  assert.equal(await a.sessionCount(), 0);
});

test("upstream: revokeSessions reports a repeated session id once", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.deepEqual(await a.revokeSessions([sessionIdOf(bundle), sessionIdOf(bundle)]), [sessionIdOf(bundle)]);
});

test("upstream: revokeSessions skips a malformed session id", async (t) => {
  const a = await open(t);
  await a.signUp();
  assert.deepEqual(await a.revokeSessions(["not a session id"]), []);
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: revokeSessions revokes nothing for no ids", async (t) => {
  const a = await open(t);
  await a.signUp();
  assert.deepEqual(await a.revokeSessions([]), []);
  assert.equal(await a.sessionCount(), 1);
});

test("upstream: token lifetime configuration honors a custom access-token TTL on sign-up", async (t) => {
  const a = await open(t);
  const before = a.clock.now;
  const bundle = await a.signUp(claims(), ttl({ accessTokenTtlSeconds: 300 }));
  const expMs = decodeJwt(bundle.accessToken).exp * 1000;
  assert.ok(expMs >= before + 300_000 - 1000);
  assert.ok(expMs <= a.clock.now + 300_000);
});

test("upstream: token lifetime configuration honors a custom inactivity timeout on sign-up and on rotation", async (t) => {
  const a = await open(t);
  const oneHourSeconds = 60 * 60;
  const oneHourMs = oneHourSeconds * 1000;
  const before = a.clock.now;
  const lifetimes = ttl({ refreshInactivityTimeoutSeconds: oneHourSeconds });
  const bundle = await a.signUp(claims(), lifetimes);
  assert.ok(bundle.refreshTokenExpiresAt >= before + oneHourMs);
  assert.ok(bundle.refreshTokenExpiresAt <= a.clock.now + oneHourMs);
  const rotated = expectRotated(await a.refresh(bundle.refreshToken, lifetimes));
  assert.ok(rotated.refreshTokenExpiresAt <= a.clock.now + oneHourMs);
});

test("upstream: token lifetime configuration caps the refresh token's expiry at the session's max lifetime", async (t) => {
  const a = await open(t, { now: START });
  const lifetimes = ttl({ refreshInactivityTimeoutSeconds: 2 * HOUR_MS / 1000, sessionMaxLifetimeSeconds: 3 * HOUR_MS / 1000 });
  const bundle = await a.signUp(claims(), lifetimes);
  const [session] = await a.sessions();
  assert.equal(bundle.refreshTokenExpiresAt, a.clock.now + 2 * HOUR_MS);
  a.clock.now += 2 * HOUR_MS - 60_000;
  const rotated = expectRotated(await a.refresh(bundle.refreshToken, lifetimes));
  assert.equal(rotated.refreshTokenExpiresAt, session._creationTime + 3 * HOUR_MS);
});

test("upstream: token lifetime configuration rejects an access TTL that is not shorter than the inactivity timeout", async (t) => {
  const a = await open(t);
  const failure = await a.defect(a.core.mutation({ ip: null }, (tx) => core_._internal_dangerous_signUp(tx, { claims: claims(), componentPath: COMPONENT_PATH, createUser: a.spy.createUser, ...DEFAULT_TTL, accessTokenTtlSeconds: 100, refreshInactivityTimeoutSeconds: 1 })));
  assert.match(failure.message, /shorter than the refresh inactivity timeout/i);
});

test("upstream: token lifetime configuration rejects an inactivity timeout longer than the max lifetime", async (t) => {
  const a = await open(t);
  const failure = await a.defect(a.core.mutation({ ip: null }, (tx) => core_._internal_dangerous_signUp(tx, { claims: claims(), componentPath: COMPONENT_PATH, createUser: a.spy.createUser, ...DEFAULT_TTL, refreshInactivityTimeoutSeconds: 2 * 60 * 60, sessionMaxLifetimeSeconds: 60 * 60 })));
  assert.match(failure.message, /at most the session max lifetime/i);
});

test("upstream: token lifetime configuration accepts an inactivity timeout equal to the max lifetime", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp(claims(), ttl({ refreshInactivityTimeoutSeconds: 60 * 60, sessionMaxLifetimeSeconds: 60 * 60 }));
  const [session] = await a.sessions();
  assert.ok(bundle.refreshTokenExpiresAt <= session._creationTime + HOUR_MS);
});

test("upstream: getSession returns the user id while the session is live", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.deepEqual(await a.getSession(sessionIdOf(bundle)), { userId: bundle.userId });
});

test("upstream: getSession keeps answering for the same session across a refresh", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const rotated = expectRotated(await a.refresh(bundle.refreshToken));
  assert.equal(sessionIdOf(rotated), sessionIdOf(bundle));
  assert.deepEqual(await a.getSession(sessionIdOf(bundle)), { userId: bundle.userId });
});

test("upstream: getSession returns null once the session is revoked", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  await a.signOut(bundle.refreshToken);
  assert.equal(await a.getSession(sessionIdOf(bundle)), null);
});

test("upstream: getSession returns null for a string that is not a session id", async (t) => {
  const a = await open(t);
  await a.signUp();
  assert.equal(await a.getSession("not-a-session-id"), null);
});

test("upstream: getSession returns null for an id in another table", async (t) => {
  const a = await open(t);
  await a.signUp();
  const tokenId = (await a.query((tx) => tx.db.query(coreTables.refreshTokens).unique()))._id;
  assert.equal(await a.getSession(tokenId), null);
});

// --- server/userId.test.ts ---------------------------------------------------

const asCaller = (a, bundle) => ({ ip: null, caller: { sessionId: sessionIdOf(bundle), userId: bundle.userId } });

test("upstream: getAuthUserId returns the user of the session the caller's subject names", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  assert.equal(await a.run(a.core.query(asCaller(a, bundle), (tx) => getAuthUserId(tx))), bundle.userId);
});

test("upstream: getAuthUserId returns null when the session is gone", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  await a.signOut(bundle.refreshToken);
  assert.equal(await a.run(a.core.query(asCaller(a, bundle), (tx) => getAuthUserId(tx))), null);
});

test("upstream: getAuthUserId returns null when the caller has no identity", async (t) => {
  const a = await open(t);
  await a.signUp();
  assert.equal(await a.query((tx) => getAuthUserId(tx)), null);
});

// --- server/setup.test.ts: the bound helpers ---------------------------------

/** A method bound to this runtime's core, signing users in as accounts named by the profile id. */
function bindAccounts(a, ttlOverride) {
  const spy = { createUser: (_tx, args) => Effect.succeed(args.method.profile.id) };
  const method = bindTestMethod(a.auth, "testMethod", { createUser: spy.createUser, onSignIn: undefined });
  return {
    ...method,
    signUp: (accountId) => method.signUp({ id: accountId }),
    signIn: (accountId) => method.signIn(accountId),
    revokeOthers: (bundle) => method.bound.mutation(bundle === undefined ? { ip: null } : asCaller(a, bundle), (tx, helpers) => helpers.revokeOtherSessions(tx)),
    revokeAll: (userId) => method.bound.mutation({ ip: null }, (tx, helpers) => helpers.revokeAllSessions(tx, userId)),
  };
}

test("upstream: revokeOtherSessions revokes every session of the user but the caller's", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  await a.run(m.signIn("alice"));
  await a.run(m.signIn("alice"));
  assert.equal(await a.run(m.revokeOthers(bundle)), 2);
});

test("upstream: revokeOtherSessions leaves the sessions of other users alone", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  await a.run(m.signIn("alice"));
  const bob = await a.run(m.signUp("bob"));
  await a.run(m.signIn("bob"));
  assert.equal(await a.run(m.revokeOthers(bundle)), 1);
  assert.equal(await a.run(m.revokeOthers(bob)), 1);
});

test("upstream: revokeOtherSessions deletes expired sessions without counting them", async (t) => {
  const a = await open(t, { now: START });
  const m = bindAccounts(a);
  await a.run(m.signUp("alice"));
  a.clock.now += 31 * DAY_MS;
  await a.run(m.signIn("alice"));
  const bundle = await a.run(m.signIn("alice"));
  assert.equal(await a.run(m.revokeOthers(bundle)), 1);
  assert.deepEqual((await a.listSessions(bundle.userId)).map((s) => s.sessionId), [sessionIdOf(bundle)]);
});

test("upstream: revokeOtherSessions counts a session as expired under an inactivity timeout lowered since it last refreshed", async (t) => {
  const a = await open(t, { now: START });
  const m = bindAccounts(a);
  await a.run(m.signUp("alice"));
  a.clock.now += 2 * 60 * 60 * 1000;
  // The same runtime redeployed with a lower inactivity timeout: a second core over the same partition.
  const { createAuthCore } = await import("../dist/auth/core/setup.js");
  const shortened = createAuthCore({ runtime: a.core, ttl: { refreshInactivityTimeoutSeconds: 60 * 60 } });
  const bound = shortened.bindMethod({ name: "testMethod", createUser: (_tx, args) => Effect.succeed(args.method.profile.id) });
  const signInShort = (accountId) => bound.mutation({ ip: null }, (tx, helpers) => helpers.completeSignIn(tx, { userId: accountId, profile: {}, authenticatedBy: COMPONENT_PATH }));
  await a.run(signInShort("alice"));
  const { tokens: bundle } = await a.run(signInShort("alice"));
  const revoked = await a.run(bound.mutation(asCaller(a, bundle), (tx, helpers) => helpers.revokeOtherSessions(tx)));
  assert.equal(revoked, 1);
});

test("upstream: revokeOtherSessions returns 0 when the caller is not signed in", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  await a.run(m.signUp("alice"));
  await a.run(m.signIn("alice"));
  assert.equal(await a.run(m.revokeOthers(undefined)), 0);
});

test("upstream: revokeOtherSessions returns 0 for a subject that is no session", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  await a.run(m.signIn("alice"));
  const revoked = await a.run(m.bound.mutation({ ip: null, caller: { sessionId: bundle.userId, userId: bundle.userId } }, (tx, helpers) => helpers.revokeOtherSessions(tx)));
  assert.equal(revoked, 0);
});

test("upstream: revokeAllSessions revokes every session of the user, the caller's included", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  await a.run(m.signIn("alice"));
  assert.equal(await a.run(m.revokeAll(bundle.userId)), 2);
  assert.deepEqual((await a.listSessions(bundle.userId)).map((s) => s.sessionId), []);
});

test("upstream: revokeAllSessions needs no signed-in caller", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  assert.equal(await a.run(m.revokeAll(bundle.userId)), 1);
});

test("upstream: revokeAllSessions leaves the sessions of other users alone", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  const alice = await a.run(m.signUp("alice"));
  const bob = await a.run(m.signUp("bob"));
  assert.equal(await a.run(m.revokeAll(alice.userId)), 1);
  assert.deepEqual((await a.listSessions(bob.userId)).map((s) => s.sessionId), [sessionIdOf(bob)]);
});

test("upstream: revokeAllSessions deletes expired sessions without counting them", async (t) => {
  const a = await open(t, { now: START });
  const m = bindAccounts(a);
  const bundle = await a.run(m.signUp("alice"));
  a.clock.now += 31 * DAY_MS;
  await a.run(m.signIn("alice"));
  assert.equal(await a.run(m.revokeAll(bundle.userId)), 1);
  assert.deepEqual((await a.listSessions(bundle.userId)).map((s) => s.sessionId), []);
});

test("upstream: revokeAllSessions returns 0 for a user with no sessions", async (t) => {
  const a = await open(t);
  const m = bindAccounts(a);
  assert.equal(await a.run(m.revokeAll("nobody")), 0);
});

test("upstream: isAuthenticated is false for a caller with no identity", async (t) => {
  const a = await open(t);
  assert.equal(await a.run(a.auth.core.isAuthenticated({ ip: null })), false);
});

test("upstream: isAuthenticated is false for a subject that is no session", async (t) => {
  const a = await open(t);
  assert.equal(await a.run(a.auth.core.isAuthenticated({ ip: null, caller: { sessionId: "not-a-session-id", userId: "x" } })), false);
});

test("upstream: isAuthenticated is true while the session is live, and false once it is revoked", async (t) => {
  const a = await open(t);
  const bundle = await a.signUp();
  const caller = asCaller(a, bundle);
  assert.equal(await a.run(a.auth.core.isAuthenticated(caller)), true);
  await a.run(a.auth.core.signOut({ ip: null }, { refreshToken: bundle.refreshToken }));
  // The JWT is untouched and still verifies; the session is what died.
  assert.equal(await a.run(a.auth.core.isAuthenticated(caller)), false);
});

test("upstream: createAuthCore rejects an invalid lifetime configuration when it is set up", async (t) => {
  const { createAuthCore } = await import("../dist/auth/core/setup.js");
  assert.throws(() => createAuthCore({ runtime: {}, ttl: { refreshInactivityTimeoutSeconds: 2 * 60 * 60, sessionMaxLifetimeSeconds: 60 * 60 } }), /at most the session max lifetime/i);
});

test("upstream: bindMethod refuses a second method with the same name", async (t) => {
  const a = await open(t);
  a.auth.core.bindMethod({ name: "twice", createUser: a.spy.createUser });
  assert.throws(() => a.auth.core.bindMethod({ name: "twice", createUser: a.spy.createUser }), /already bound/);
});

// --- lib/ttl.test.ts ----------------------------------------------------------

test("upstream: resolveTtlConfig fills in every default when given nothing", () => {
  assert.deepEqual(resolveTtlConfig({}), { accessTokenTtlSeconds: DEFAULT_ACCESS_TOKEN_TTL_SECONDS, refreshInactivityTimeoutSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS, sessionMaxLifetimeSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS });
  assert.equal(DEFAULT_ACCESS_TOKEN_TTL_SECONDS, 300);
});

test("upstream: resolveTtlConfig keeps the values the runtime sets", () => {
  const set = { accessTokenTtlSeconds: 300, refreshInactivityTimeoutSeconds: 60 * 60, sessionMaxLifetimeSeconds: 2 * 60 * 60 };
  assert.deepEqual(resolveTtlConfig(set), set);
});

test("upstream: resolveTtlConfig defaults the inactivity timeout to the runtime's max lifetime", () => {
  assert.equal(resolveTtlConfig({ sessionMaxLifetimeSeconds: 60 * 60 }).refreshInactivityTimeoutSeconds, 60 * 60);
});

test("upstream: resolveTtlConfig rejects an inactivity timeout longer than the default max lifetime", () => {
  assert.throws(() => resolveTtlConfig({ refreshInactivityTimeoutSeconds: 2 * DEFAULT_SESSION_MAX_LIFETIME_SECONDS }), /at most the session max lifetime/i);
});

for (const args of [{ accessTokenTtlSeconds: NaN }, { refreshInactivityTimeoutSeconds: NaN }, { sessionMaxLifetimeSeconds: NaN }, { sessionMaxLifetimeSeconds: Infinity }]) {
  test(`upstream: resolveTtlConfig rejects a non-finite lifetime: ${JSON.stringify(args)}`, () => {
    assert.throws(() => resolveTtlConfig(args), /finite/i);
  });
}

test("the access-token lifetime is at most one hour", () => {
  assert.throws(() => resolveTtlConfig({ accessTokenTtlSeconds: 3601 }), /at most one hour/);
  assert.equal(resolveTtlConfig({ accessTokenTtlSeconds: 3600 }).accessTokenTtlSeconds, 3600);
});
