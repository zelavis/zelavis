/**
 * Zelavis Auth, OAuth providers: the pure pieces (redirect origins, profile mappings, Apple's name and client secret),
 * the operator's connections (sealed secrets, validation, the environment fallback, who may change them), OpenID
 * Connect discovery, and rollback of a rejected redemption. Cases follow upstream's
 * `methods/{google,apple,github}/profile.test.ts`, `components/apple/{user,secret}.test.ts`,
 * `methods/oauth/server.test.ts` and `components/oauth/redemption.test.ts`, and Zelavis's own
 * `test/oauth-discovery.test.mjs` and `test/auth-oauth-connections.test.mjs`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect } from "effect";
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { createServiceRuntime } from "../dist/core/index.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { oauthFlowTables } from "../dist/auth/lib/oauth/schema.js";
import { validateAllowedRedirectOrigins } from "../dist/auth/lib/oauth/redemption.js";
import { mintClientSecret, toPkcs8Pem } from "../dist/auth/apple/secret.js";
import { sanitizeAppleUser } from "../dist/auth/apple/user.js";
import { normalizeAppleProfile } from "../dist/auth/methods/apple.js";
import { normalizeGithubProfile } from "../dist/auth/methods/github.js";
import { normalizeGoogleProfile } from "../dist/auth/methods/google.js";
import { normalizeOidcProfile, setupOAuth } from "../dist/auth/methods/oauth.js";
import { discoverIssuer } from "../dist/auth/oauth/discovery.js";
import { oauthConnectionsTables } from "../dist/auth/oauth/tables.js";
import { environmentConnection, publicConnection } from "../dist/auth/oauth/connections.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { TEST_MASTER_SECRET, bindTestMethod, fakeOAuthProvider, fragmentOf, openAuth } from "./_auth.mjs";

const ORIGIN = "https://auth.example.test";
const APP = "https://app.example.test";

// --- redirect origins (upstream methods/oauth/server.test.ts) ------------------------------------------------------

test("upstream: http(s) redirect origins are accepted, a trailing slash is normalized, anything else is refused", () => {
  assert.deepEqual(validateAllowedRedirectOrigins(["https://app.example.test", "http://localhost:5173", "https://app.example.test/"]), ["https://app.example.test", "http://localhost:5173", "https://app.example.test"]);
  for (const bad of ["myapp://callback", "not a url", "ftp://example.test", "https://app.example.test/path", "https://app.example.test?x=1", "https://app.example.test/#frag"]) {
    assert.throws(() => validateAllowedRedirectOrigins([bad]), /allowedRedirectOrigins entry/, bad);
  }
});

// --- profile mappings (upstream methods/{google,apple,github}/profile.test.ts) -------------------------------------

test("upstream: google maps validated claims, carries the Workspace domain, treats an absent email_verified as unverified, throws with no id_token", () => {
  assert.deepEqual(normalizeGoogleProfile({ sub: "g1", email: "a@example.test", email_verified: true, name: "A", picture: "https://p" }), {
    id: "g1", email: "a@example.test", emailVerified: true, hostedDomain: undefined, name: "A", picture: "https://p",
  });
  assert.equal(normalizeGoogleProfile({ sub: "g", hd: "corp.example" }).hostedDomain, "corp.example");
  assert.equal(normalizeGoogleProfile({ sub: "g", hd: 42 }).hostedDomain, undefined);
  assert.equal(normalizeGoogleProfile({ sub: "g", email: "a@b.c" }).emailVerified, false);
  assert.equal(normalizeGoogleProfile({ sub: "g", email_verified: "true" }).emailVerified, false, "Google sends a boolean");
  assert.throws(() => normalizeGoogleProfile(undefined), /no id_token/);
});

test("upstream: apple takes the name from the callback on a first sign-in, none on a return visit, and reads both spellings of email_verified", () => {
  assert.equal(normalizeAppleProfile({ sub: "a1", email: "x@privaterelay.appleid.com", email_verified: true }, { name: { firstName: "Ada", lastName: "Lovelace" } }).name, "Ada Lovelace");
  assert.equal(normalizeAppleProfile({ sub: "a1" }, undefined).name, undefined);
  assert.equal(normalizeAppleProfile({ sub: "a1" }, { name: { firstName: "Ada" } }).name, "Ada");
  assert.equal(normalizeAppleProfile({ sub: "a1" }, { name: {} }).name, undefined);
  for (const [claim, expected] of [[true, true], ["true", true], [false, false], ["false", false], [undefined, false]]) {
    assert.equal(normalizeAppleProfile({ sub: "a", email_verified: claim }, undefined).emailVerified, expected, String(claim));
  }
  assert.equal(normalizeAppleProfile({ sub: "a" }, undefined).email, undefined);
});

test("upstream: github prefers the primary verified email, falls back to any verified one, then to the public one marked unverified; stringifies the id", () => {
  const user = { id: 7, login: "octo", name: null, email: "public@example.test", avatar_url: "https://a" };
  assert.deepEqual(
    normalizeGithubProfile({ user, emails: [{ email: "b@x", primary: false, verified: true }, { email: "p@x", primary: true, verified: true }] }),
    { id: "7", login: "octo", name: "octo", email: "p@x", emailVerified: true, avatarUrl: "https://a" },
  );
  assert.equal(normalizeGithubProfile({ user, emails: [{ email: "b@x", primary: false, verified: true }, { email: "p@x", primary: true, verified: false }] }).email, "b@x");
  const fallback = normalizeGithubProfile({ user, emails: [{ email: "p@x", primary: true, verified: false }] });
  assert.equal(fallback.email, "public@example.test");
  assert.equal(fallback.emailVerified, false);
  assert.equal(normalizeGithubProfile({ user: { ...user, name: "Named" }, emails: [] }).name, "Named");
  assert.throws(() => normalizeGithubProfile(undefined), /missing the `user` entry/);
  assert.throws(() => normalizeGithubProfile({ user: { login: "x" }, emails: [] }), /missing an id/);
});

test("an OpenID Connect profile reads the id_token claims", () => {
  assert.deepEqual(normalizeOidcProfile({ sub: "o1", email: "o@x", email_verified: "true", name: "O", picture: "https://p" }), { id: "o1", email: "o@x", emailVerified: true, name: "O", picture: "https://p" });
  assert.equal(normalizeOidcProfile({ sub: "o2", email: 5 }).email, undefined);
  assert.throws(() => normalizeOidcProfile(undefined), /no id_token/);
});

// --- Apple's name and client secret (upstream components/apple/{user,secret}.test.ts) ------------------------------

test("upstream: the Apple user field yields its name only, trimmed, capped at 256 characters, from a well-formed object", () => {
  const name = (firstName, lastName) => JSON.stringify({ name: { firstName, lastName }, email: "forged@evil.test" });
  assert.deepEqual(sanitizeAppleUser(name("Ada", "Lovelace")), { name: { firstName: "Ada", lastName: "Lovelace" } });
  assert.deepEqual(sanitizeAppleUser(name("  Ada ", undefined)), { name: { firstName: "Ada", lastName: undefined } });
  assert.equal(sanitizeAppleUser(name("x".repeat(257), undefined)), undefined);
  assert.equal(sanitizeAppleUser(name("x".repeat(256), undefined))?.name.firstName, "x".repeat(256));
  for (const raw of [null, "", "not json", "null", "[]", '"text"', JSON.stringify({}), JSON.stringify({ name: "Ada" }), JSON.stringify({ name: { firstName: 5 } })]) {
    assert.equal(sanitizeAppleUser(raw), undefined, String(raw));
  }
  assert.deepEqual(sanitizeAppleUser(JSON.stringify({ name: { firstName: "A", extra: "dropped" } })), { name: { firstName: "A", lastName: undefined } });
});

test("upstream: Apple's key is reshaped to PKCS#8, and the client secret carries Apple's header and claims and verifies against the key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const body = pem.replace(/-----[A-Z ]+-----|\s/g, "");
  assert.equal(toPkcs8Pem(pem), pem.trim());
  assert.equal(toPkcs8Pem(`  ${pem}  `), pem.trim());
  assert.equal(toPkcs8Pem(pem.trim().replace(/\n/g, "\\n")), pem.trim());
  assert.equal(toPkcs8Pem(body), `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`);

  const options = { privateKey: pem, teamId: "TEAM123456", keyId: "KEY1234567", clientId: "com.example.services", now: 1_700_000_000_000 };
  const secret = await Effect.runPromise(mintClientSecret(options));
  assert.deepEqual(decodeProtectedHeader(secret), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  assert.deepEqual(decodeJwt(secret), { iss: "TEAM123456", sub: "com.example.services", aud: "https://appleid.apple.com", iat: 1_700_000_000, exp: 1_700_000_300 });
  const verified = await jwtVerify(secret, await importSPKI(publicKey.export({ type: "spki", format: "pem" }), "ES256"), { currentDate: new Date(1_700_000_001_000) });
  assert.equal(verified.payload.sub, "com.example.services");
  // The same key given with escaped newlines signs the same way.
  const escaped = await Effect.runPromise(mintClientSecret({ ...options, privateKey: pem.trim().replace(/\n/g, "\\n") }));
  assert.deepEqual(decodeJwt(escaped), decodeJwt(secret));
  // A key that is not a key, or of the wrong type, is refused before anything is signed.
  for (const bad of ["not a key", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" })]) {
    const failed = await Effect.runPromise(Effect.flip(mintClientSecret({ ...options, privateKey: bad })));
    assert.equal(failed._tag, "OAuthProviderFailure");
    assert.match(failed.message, /private key is not a P-256 private key/);
    assert.ok(!failed.message.includes("not a key"));
  }
});

// --- connections -------------------------------------------------------------------------------------------------------

async function open(t, { environment, kind = "github", now } = {}) {
  let a;
  const provider = await fakeOAuthProvider(t, { kind, now: () => a.clock.now });
  a = await openAuth(t, { ...(now === undefined ? {} : { now }), oauth: { fetch: provider.fetch, allowedRedirectOrigins: [APP], environment } });
  return { ...a, provider, oauth: a.auth.methods.oauth, rows: (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect())) };
}
const GOOD = { clientId: "id-1", clientSecret: "secret-1", redirectUri: `${ORIGIN}/auth/oauth/github/callback` };

test("a connection stores its secret sealed and never returns it", async (t) => {
  const a = await open(t);
  const saved = await a.run(a.oauth.connections.configure("github", GOOD));
  assert.equal(saved.status, "saved");
  assert.deepEqual(saved.connection, {
    provider: "github", clientId: "id-1", redirectUri: GOOD.redirectUri, enabled: true, updatedAt: saved.connection.updatedAt, hasClientSecret: true,
  });
  assert.ok(!JSON.stringify(saved).includes("secret-1"));
  const [row] = await a.rows(oauthConnectionsTables.connections);
  assert.ok(!JSON.stringify(row).includes("secret-1"), "the stored row holds no raw secret");
  assert.equal(row.sealedClientSecret.algorithm, "AES-256-GCM");
  const listed = await a.run(a.oauth.connections.list());
  assert.ok(!JSON.stringify(listed).includes("secret-1"));
  assert.deepEqual(listed.map((entry) => [entry.provider, entry.configured, entry.hasClientSecret]), [["apple", false, false], ["github", true, true], ["google", false, false]]);
  // A save without a secret keeps the stored one; a connection whose secret cannot be opened (another master secret) is unusable, not a crash.
  assert.equal((await a.run(a.oauth.connections.configure("github", { ...GOOD, clientSecret: undefined, clientId: "id-2" }))).connection.hasClientSecret, true);
  assert.equal((await a.run(a.oauth.connections.read("github"))).clientSecret, "secret-1");
});

test("a connection is validated: the callback must name the provider, https unless loopback, secrets and Apple's key", async (t) => {
  const a = await open(t);
  const invalid = async (provider, input, pattern) => {
    const failure = await a.run(Effect.flip(a.oauth.connections.configure(provider, input)));
    assert.equal(failure._tag, "OAuthConnectionInvalid");
    assert.match(failure.message, pattern);
  };
  await invalid("github", { ...GOOD, clientId: "  " }, /clientId/);
  await invalid("github", { ...GOOD, redirectUri: "not a url" }, /absolute URL/);
  await invalid("github", { ...GOOD, redirectUri: "http://auth.example.test/auth/oauth/github/callback" }, /https/);
  await invalid("github", { ...GOOD, redirectUri: `${ORIGIN}/auth/oauth/google/callback` }, /must end with \/auth\/oauth\/github\/callback/);
  await invalid("github", { ...GOOD, clientSecret: undefined }, /clientSecret is required/);
  await invalid("github", { ...GOOD, issuer: "https://issuer.example.test" }, /takes no issuer/);
  await invalid("github", { nope: 1 }, /clientId and a redirectUri/);
  await invalid("apple", { clientId: "c", clientSecret: "k", redirectUri: `${ORIGIN}/auth/oauth/apple/callback` }, /teamId and a keyId/);
  await invalid("apple", { clientId: "c", clientSecret: "not a key", teamId: "T", keyId: "K", redirectUri: `${ORIGIN}/auth/oauth/apple/callback` }, /P-256 private key/);
  // Loopback http is allowed for development.
  assert.equal((await a.run(a.oauth.connections.configure("github", { ...GOOD, redirectUri: "http://localhost:3000/auth/oauth/github/callback" }))).status, "saved");
  // Anything that is not a built-in provider needs an issuer; a reserved or malformed name is no provider.
  for (const name of ["acme", "connections", "providers", "Bad Name", "-x"]) {
    assert.deepEqual(await a.run(a.oauth.connections.configure(name, { ...GOOD, redirectUri: `${ORIGIN}/auth/oauth/${name}/callback` })), { status: "unknown" }, name);
  }
  assert.deepEqual(await a.rows(oauthConnectionsTables.connections).then((rows) => rows.map((row) => row.provider)), ["github"]);
});

test("the environment connection applies when nothing is stored; what is stored wins; removing falls back to it", async (t) => {
  const environment = { ZELAVIS_AUTH_GITHUB_CLIENT_ID: "env-id", ZELAVIS_AUTH_GITHUB_CLIENT_SECRET: "env-secret", ZELAVIS_AUTH_GITHUB_REDIRECT_URI: `${ORIGIN}/auth/oauth/github/callback`, ZELAVIS_AUTH_GITHUB_SCOPES: "read:user,gist" };
  const a = await open(t, { environment });
  const fromEnvironment = await a.run(a.oauth.connections.read("github"));
  assert.equal(fromEnvironment.clientId, "env-id");
  assert.equal(fromEnvironment.clientSecret, "env-secret");
  assert.deepEqual(fromEnvironment.scopes, ["read:user", "gist"]);
  assert.equal((await a.run(a.oauth.providers())).map((p) => p.name).join(), "github");
  const started = await a.run(a.oauth.startSignIn({ ip: null }, { provider: "github", redirectTo: `${APP}/x` }));
  assert.equal(new URL(started.redirect).searchParams.get("client_id"), "env-id");
  assert.equal(new URL(started.redirect).searchParams.get("scope"), "read:user user:email gist");
  await a.run(a.oauth.connections.configure("github", GOOD));
  assert.equal((await a.run(a.oauth.connections.read("github"))).clientId, "id-1");
  await a.run(a.oauth.connections.remove("github"));
  assert.equal((await a.run(a.oauth.connections.read("github"))).clientId, "env-id");
  assert.equal(environmentConnection({}, "github"), undefined);
  assert.equal(environmentConnection(environment, "acme"), undefined, "only the built-in providers read the environment");
  assert.ok(!("clientSecret" in publicConnection(fromEnvironment)));
});

test("the providers list offers only connected, enabled providers by name and title", async (t) => {
  const a = await open(t);
  assert.deepEqual(await a.run(a.oauth.providers()), []);
  await a.run(a.oauth.connections.configure("github", GOOD));
  await a.run(a.oauth.connections.configure("acme", { ...GOOD, redirectUri: `${ORIGIN}/auth/oauth/acme/callback`, issuer: a.provider.origin }));
  assert.deepEqual(await a.run(a.oauth.providers()), [{ name: "acme", title: "acme" }, { name: "github", title: "GitHub" }]);
  await a.run(a.oauth.connections.configure("github", { ...GOOD, enabled: false }));
  assert.deepEqual((await a.run(a.oauth.providers())).map((p) => p.name), ["acme"]);
});

test("the connections routes need the settings permission; the providers list is public and carries no secret", async (t) => {
  const a = await open(t);
  const runtime = await createServiceRuntime({
    endpointGroups: [{ id: "auth", basePath: "/auth", api: { v1: a.auth.routes }, context: a.auth, authenticators: [a.auth.requestAuthenticator], origin: { type: "subsystem", subsystem: "auth-test" } }],
  });
  const call = (path, { method = "GET", body, headers = {} } = {}) => runtime.fetch(new Request(`${ORIGIN}/auth/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  assert.equal((await call("oauth/connections")).status, 401);
  assert.equal((await call("oauth/connections/github", { method: "PUT", body: GOOD })).status, 401);
  const bundle = await a.run(bindTestMethod(a.auth).signUp());
  const bearer = { authorization: `Bearer ${bundle.tokens?.accessToken ?? bundle.accessToken}` };
  assert.equal((await call("oauth/connections", { headers: bearer })).status, 403);
  assert.equal((await call("oauth/connections/github", { method: "PUT", body: GOOD, headers: bearer })).status, 403);
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => tx.db.patch(accountsTables.accounts, bundle.userId, { permissions: ["system.settings.manage"] })));
  const saved = await call("oauth/connections/github", { method: "PUT", body: GOOD, headers: bearer });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).connection.hasClientSecret, true);
  assert.equal((await call("oauth/connections/github", { method: "PUT", body: { ...GOOD, clientSecret: undefined, redirectUri: "x" }, headers: bearer })).status, 400);
  assert.equal((await call("oauth/connections/acme", { method: "PUT", body: GOOD, headers: bearer })).status, 404);
  const listed = await (await call("oauth/connections", { headers: bearer })).json();
  assert.ok(!JSON.stringify(listed).includes("secret-1"));
  const publicList = await call("oauth/providers");
  assert.equal(publicList.status, 200);
  assert.deepEqual(await publicList.json(), { providers: [{ name: "github", title: "GitHub" }] });
  assert.equal((await call("oauth/connections/github", { method: "DELETE", headers: bearer })).status, 204);
  assert.deepEqual(await (await call("oauth/providers")).json(), { providers: [] });
});

// --- OpenID Connect discovery (test/oauth-discovery.test.mjs) ---------------------------------------------------------

const ISSUER = "https://id.example.com";
const configuration = (overrides = {}) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  id_token_signing_alg_values_supported: ["RS256", "ES256"],
  ...overrides,
});
const stub = (handler) => {
  const calls = [];
  return { calls, fetch: async (url) => { calls.push(String(url)); return handler(String(url)); } };
};
const discover = (fetch, issuer = ISSUER) => Effect.runPromise(Effect.flip(discoverIssuer(fetch, issuer, 5)).pipe(Effect.map((failure) => failure.message)));

test("an issuer describes itself, so no constants are needed", async () => {
  const { calls, fetch } = stub(() => Response.json(configuration()));
  const found = await Effect.runPromise(discoverIssuer(fetch, ISSUER, 5));
  assert.equal(calls[0], `${ISSUER}/.well-known/openid-configuration`);
  assert.deepEqual(found, { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUrl: `${ISSUER}/jwks`, algorithms: ["RS256", "ES256"], discoveredAt: 5 });
  assert.equal((await Effect.runPromise(discoverIssuer(fetch, `${ISSUER}/`, 5))).issuer, ISSUER, "a trailing slash does not defeat the match");
});

test("discovery refuses another issuer, plaintext, an incomplete document, a failing, unreachable or non-OpenID answer", async () => {
  assert.match(await discover(stub(() => Response.json(configuration({ issuer: "https://attacker.example" }))).fetch), /declares a different issuer/);
  assert.match(await discover(stub(() => Response.json(configuration({ jwks_uri: "http://id.example.com/jwks" }))).fetch), /must use https/);
  assert.match(await discover(stub(() => Response.json(configuration())).fetch, "http://id.example.com"), /must use https/);
  for (const missing of ["authorization_endpoint", "token_endpoint", "jwks_uri", "issuer"]) {
    const { [missing]: _gone, ...partial } = configuration();
    assert.match(await discover(stub(() => Response.json(partial)).fetch), new RegExp(`missing "${missing}"`), missing);
  }
  assert.match(await discover(stub(() => new Response("nope", { status: 503 })).fetch), /status 503/);
  assert.match(await discover(() => Promise.reject(new TypeError("fetch failed"))), /Could not reach https:\/\/id\.example\.com\/\.well-known\/openid-configuration/);
  assert.match(await discover(stub(() => new Response("<html></html>", { status: 200 })).fetch), /did not return an OpenID configuration document/);
});

test("an OpenID Connect connection reads its metadata again when it is a day old, and keeps it when the issuer is unreachable", async (t) => {
  const a = await open(t, { kind: "oidc" });
  await a.run(a.oauth.connections.configure("acme", { ...GOOD, redirectUri: `${ORIGIN}/auth/oauth/acme/callback`, issuer: a.provider.origin }));
  const discoveries = () => a.provider.requests.filter((r) => r.path === "/.well-known/openid-configuration").length;
  assert.equal(discoveries(), 1);
  await a.run(a.oauth.startSignIn({ ip: null }, { provider: "acme", redirectTo: `${APP}/x` }));
  assert.equal(discoveries(), 1, "fresh metadata is not read again");
  a.clock.now += 25 * 60 * 60 * 1000;
  await a.run(a.oauth.startSignIn({ ip: null }, { provider: "acme", redirectTo: `${APP}/x` }));
  assert.equal(discoveries(), 2);
  a.provider.state.discoveryIssuer = "https://changed.example.test";
  a.clock.now += 25 * 60 * 60 * 1000;
  const started = await a.run(a.oauth.startSignIn({ ip: null }, { provider: "acme", redirectTo: `${APP}/x` }));
  assert.equal(started.status, "started", "an issuer that now answers wrongly leaves the stored endpoints in use");
});

// --- redemption rolls back (upstream components/oauth/redemption.test.ts) ---------------------------------------------

test("upstream: an app rejection rolls back the ticket claim and the account", async (t) => {
  const a = await open(t, { kind: "github" });
  await a.run(a.oauth.connections.configure("github", { ...GOOD, clientSecret: a.provider.state.clientSecret, clientId: a.provider.state.clientId }));
  const rejecting = setupOAuth(a.auth.core, {
    runtime: a.auth.runtime, masterSecret: TEST_MASTER_SECRET, clock: () => a.clock.now, fetch: a.provider.fetch,
    allowedRedirectOrigins: [APP], onSignIn: () => Effect.die(new Error("the app rejects this sign-in")),
  });
  const started = await a.run(rejecting.startSignIn({ ip: null }, { provider: "github", redirectTo: `${APP}/x` }));
  const authorized = a.provider.authorize(started.redirect);
  const runtime = await createServiceRuntime({
    endpointGroups: [{ id: "auth", basePath: "/auth", api: { v1: a.auth.routes }, context: a.auth, authenticators: [a.auth.requestAuthenticator], origin: { type: "subsystem", subsystem: "auth-test" } }],
  });
  const response = await runtime.fetch(new Request(authorized.callback, { redirect: "manual" }));
  const ticket = fragmentOf(response).fragment.get("ticket");
  assert.ok(ticket);
  await assert.rejects(a.run(rejecting.completeSignIn({ ip: null }, { provider: "github", code: ticket, state: started.state })), /the app rejects this sign-in/);
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1, "only a successful redemption consumes the ticket");
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
});
