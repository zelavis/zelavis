/**
 * Zelavis Auth, OAuth: the flow over HTTP against a fake provider (a local server with token, key set, userinfo and
 * discovery endpoints): start, the provider's callback, redeeming the ticket, linking, and the failure paths.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRuntime } from "../dist/core/index.js";
import { setRequestClientAddress } from "../dist/core/runtime/client-address.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { oauthFlowTables } from "../dist/auth/lib/oauth/schema.js";
import { oauthTables } from "../dist/auth/oauth/tables.js";
import { googleTables } from "../dist/auth/google/tables.js";
import { githubTables } from "../dist/auth/github/tables.js";
import { createExpiredFlowsSweep } from "../dist/auth/oauth/cleanup.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { Effect } from "effect";
import { bindTestMethod, fakeOAuthProvider, fragmentOf, openAuth } from "./_auth.mjs";

const ORIGIN = "https://auth.example.test";
const APP = "https://app.example.test";
const REDIRECT_TO = `${APP}/after`;
const NAMES = { oidc: "acme", google: "google", apple: "apple", github: "github" };

async function compose(t, { kind = "oidc", connect = true, moreIssuers = [], environment, fetchThrough } = {}) {
  let a;
  const provider = await fakeOAuthProvider(t, { kind, now: () => a.clock.now });
  const issuerFor = (url) => moreIssuers.find((issuer) => issuer.origin === new URL(url).origin) ?? provider;
  const fetch = (url, init) => issuerFor(url).fetch(url, init);
  a = await openAuth(t, { oauth: { fetch: fetchThrough?.(fetch) ?? fetch, allowedRedirectOrigins: [APP], environment } });
  const running = await a.run(a.auth.start());
  t.after(() => a.run(running.stop()));
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
  const name = NAMES[kind];
  const client = { address: "198.51.100.9" };
  const call = (path, { method = "GET", headers = {}, body, form, url } = {}) => {
    const request = new Request(url ?? `${ORIGIN}/auth/${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
      redirect: "manual",
    });
    setRequestClientAddress(request, client.address);
    return runtime.fetch(request);
  };
  const post = (path, body, headers) => call(path, { method: "POST", body, headers });
  const bearer = (bundle) => ({ authorization: `Bearer ${bundle.accessToken}` });
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const configure = (providerName, extra = {}) => a.run(a.auth.methods.oauth.connections.configure(providerName, {
    clientId: provider.state.clientId,
    clientSecret: provider.state.clientSecret,
    redirectUri: `${ORIGIN}/auth/oauth/${providerName}/callback`,
    ...(providerName === "apple" ? { teamId: "TEAM123456", keyId: "KEY1234567" } : {}),
    ...(kind === "oidc" && providerName === name ? { issuer: provider.origin } : {}),
    ...extra,
  }));
  if (connect) assert.equal((await configure(name)).status, "saved");

  /** Start, the provider's redirect, the callback: the callback's response and what it carries. */
  const flow = async (providerName = name, { redirectTo = REDIRECT_TO, error, userField } = {}) => {
    const started = await json(await post(`oauth/${providerName}/start`, { redirectTo }), 200);
    const authorized = issuerFor(started.url).authorize(started.url, { error });
    const response = authorized.formPost
      ? await call("", { method: "POST", url: authorized.params.redirect_uri, form: { ...authorized.fields, ...(userField === undefined ? {} : { user: userField }) } })
      : await call("", { url: authorized.callback });
    const outcome = response.status === 302 || response.status === 303 ? fragmentOf(response).fragment : undefined;
    return { started, authorized, response, ticket: outcome?.get("ticket") ?? undefined, error: outcome?.get("error") ?? undefined, state: started.state };
  };
  const redeem = (providerName, body, headers) => post(`oauth/${providerName}/redeem`, body, headers);
  /** A whole sign-in: the token bundle. */
  const signIn = async (providerName = name) => {
    const f = await flow(providerName);
    assert.ok(f.ticket, `no ticket: ${f.error}`);
    return json(await redeem(providerName, { ticket: f.ticket, state: f.state }), 200);
  };
  return { ...a, provider, runtime, name, call, post, bearer, rows, configure, flow, redeem, signIn, client };
}

const json = async (response, status) => {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${await response.clone().text()}`);
  return response.json();
};

// --- starting a sign-in (upstream components/oauth/authorize.test.ts) ----------------------------------------------

test("upstream: the redirect carries the flow parameters and the connection's callback URL", async (t) => {
  const a = await compose(t);
  const started = await json(await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO }), 200);
  const url = new URL(started.url);
  assert.equal(`${url.origin}${url.pathname}`, `${a.provider.origin}/authorize`);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-1");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/auth/oauth/acme/callback`);
  assert.equal(url.searchParams.get("state"), started.state);
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("nonce"), "an id_token provider gets a nonce");
  assert.equal(url.searchParams.get("response_mode"), null, "a provider that redirects the callback sends no response_mode");
});

test("upstream: the redirect carries an S256 challenge of the recorded verifier, and the returned state hashes to the recorded state hash", async (t) => {
  const a = await compose(t);
  const started = await json(await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO }), 200);
  const [request] = await a.rows(oauthFlowTables.authorizationRequests);
  const { createHash } = await import("node:crypto");
  assert.equal(new URL(started.url).searchParams.get("code_challenge"), createHash("sha256").update(request.codeVerifier).digest("base64url"));
  assert.equal(request.stateHash, createHash("sha256").update(started.state).digest("hex"));
  assert.equal(request.providerName, "acme");
  assert.equal(request.redirectTo, REDIRECT_TO);
  assert.equal(request.callbackUrl, `${ORIGIN}/auth/oauth/acme/callback`);
});

test("upstream: a redirectTo outside the allowed origins, or that is not an absolute URL, is rejected and stores nothing", async (t) => {
  const a = await compose(t);
  for (const redirectTo of ["https://evil.example.test/steal", "/relative/path", "not a url", "javascript:alert(1)", `${APP}.evil.test/x`]) {
    const body = await json(await a.post("oauth/acme/start", { redirectTo }), 400);
    assert.equal(body.code, "invalid_redirect", redirectTo);
  }
  assert.deepEqual(await a.rows(oauthFlowTables.authorizationRequests), []);
  // The origin of the registered callback is a public origin of this runtime too.
  assert.equal((await a.post("oauth/acme/start", { redirectTo: `${ORIGIN}/dashboard` })).status, 200);
});

test("a provider that posts its callback asks for form_post; one that returns no id_token gets no nonce", async (t) => {
  const apple = await compose(t, { kind: "apple" });
  const started = await json(await apple.post("oauth/apple/start", { redirectTo: REDIRECT_TO }), 200);
  assert.equal(new URL(started.url).searchParams.get("response_mode"), "form_post");
  assert.equal(new URL(started.url).searchParams.get("scope"), "name email");
  const github = await compose(t, { kind: "github" });
  const url = new URL((await json(await github.post("oauth/github/start", { redirectTo: REDIRECT_TO }), 200)).url);
  assert.equal(url.searchParams.get("nonce"), null);
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
});

test("an unknown, disabled or unconnected provider is 404 at start", async (t) => {
  const a = await compose(t);
  assert.equal((await json(await a.post("oauth/nobody/start", { redirectTo: REDIRECT_TO }), 404)).code, "unknown_provider");
  assert.equal((await a.post("oauth/google/start", { redirectTo: REDIRECT_TO })).status, 404);
  await configure(a, "acme", { enabled: false });
  assert.equal((await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO })).status, 404);
  assert.equal((await a.post("oauth/acme/start", { nothing: true })).status, 400);
});

const configure = (a, name, extra) => a.configure(name, extra);

// --- the callback and redeeming the ticket (upstream components/oauth/{http,redemption}.test.ts) -------------------

test("an id_token flow exchanges the code, redirects with a ticket in the fragment, and redeeming it signs in exactly one new account", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  assert.equal(f.response.status, 302);
  const { location, fragment } = fragmentOf(f.response);
  assert.equal(`${location.origin}${location.pathname}`, REDIRECT_TO);
  assert.equal(location.search, "", "the ticket is never in the query");
  assert.ok(fragment.get("ticket"));
  assert.equal(f.response.headers.get("referrer-policy"), "no-referrer");
  // The token exchange carried PKCE, the callback URL and the client credentials.
  const exchange = a.provider.requests.find((r) => r.path === "/token");
  assert.equal(exchange.form.grant_type, "authorization_code");
  assert.equal(exchange.form.redirect_uri, `${ORIGIN}/auth/oauth/acme/callback`);
  assert.equal(exchange.form.client_secret, "client-secret-1");
  assert.ok(exchange.form.code_verifier);
  // Nothing user-visible exists until the ticket is redeemed.
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1);

  const body = await json(await a.redeem("acme", { ticket: f.ticket, state: f.state }), 200);
  assert.equal(body.status, "complete");
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);
  assert.equal((await a.rows(oauthTables.accounts)).length, 1);
  assert.equal((await a.rows(coreTables.sessions)).length, 1);
  assert.deepEqual((await a.rows(oauthFlowTables.tickets)), []);
  const [session] = await a.rows(coreTables.sessions);
  assert.equal(session.component, "oauth");
  // The token bundle authenticates.
  const me = await json(await a.call("session", { headers: a.bearer(body.tokens) }), 200);
  assert.equal(me.account?.id ?? me.userId ?? me.principal?.id, body.userId);
});

test("signing in again as the same identity signs the same user in; a second identity is a second account", async (t) => {
  const a = await compose(t);
  const first = await a.signIn();
  const again = await a.signIn();
  assert.equal(again.userId, first.userId);
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);
  assert.equal((await a.rows(coreTables.sessions)).length, 2);
  a.provider.state.subject = "subject-2";
  const other = await a.signIn();
  assert.notEqual(other.userId, first.userId);
  assert.equal((await a.rows(accountsTables.accounts)).length, 2);
  assert.equal((await a.rows(oauthTables.accounts)).length, 2);
});

test("reconfiguring a connection rejects old flows and keeps identical subjects from different issuers separate", async (t) => {
  const moreIssuers = [];
  const a = await compose(t, { moreIssuers });
  const first = await a.signIn();
  const pendingTicket = await a.flow();
  const started = await json(await a.post(`oauth/${a.name}/start`, { redirectTo: REDIRECT_TO }), 200);
  const pendingCallback = a.provider.authorize(started.url);
  const other = await fakeOAuthProvider(t, { now: () => a.clock.now });
  moreIssuers.push(other);
  const switched = await a.configure(a.name, { issuer: other.origin });
  assert.ok(!("revision" in switched.connection));

  const posted = await a.call("", { url: pendingCallback.callback });
  assert.equal(fragmentOf(posted).fragment.get("error"), "oauth_error");
  assert.equal(other.requests.filter(({ path }) => path === "/token").length, 0);
  const old = await a.redeem(a.name, { ticket: pendingTicket.ticket, state: pendingTicket.state });
  assert.equal((await json(old, 400)).code, "invalid_code");

  const second = await a.signIn();
  assert.notEqual(first.userId, second.userId);
  assert.deepEqual(new Set((await a.rows(oauthTables.accounts)).map(({ issuer }) => issuer)), new Set([a.provider.origin, other.origin]));

  await a.configure(a.name, { issuer: a.provider.origin });
  assert.equal((await a.signIn()).userId, first.userId);
});

test("changing the connection during code exchange prevents the old callback from minting a ticket", async (t) => {
  const reachedExchange = Promise.withResolvers();
  const resumeExchange = Promise.withResolvers();
  const a = await compose(t, {
    fetchThrough: (fetch) => async (url, init) => {
      if (new URL(url).pathname === "/token") {
        reachedExchange.resolve();
        await resumeExchange.promise;
      }
      return fetch(url, init);
    },
  });
  const flow = a.flow();
  try {
    await Promise.race([reachedExchange.promise, flow.then(() => assert.fail("callback finished before token exchange"))]);
    await a.configure(a.name);
  } finally {
    resumeExchange.resolve();
  }
  assert.equal((await flow).error, "oauth_error");
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
});

test("removing a stored override does not revive a pending environment ticket", async (t) => {
  const a = await compose(t, {
    kind: "github",
    connect: false,
    environment: {
      ZELAVIS_AUTH_GITHUB_CLIENT_ID: "client-1",
      ZELAVIS_AUTH_GITHUB_CLIENT_SECRET: "client-secret-1",
      ZELAVIS_AUTH_GITHUB_REDIRECT_URI: `${ORIGIN}/auth/oauth/github/callback`,
    },
  });
  const pending = await a.flow();
  assert.ok(pending.ticket);
  await a.configure(a.name);
  await a.run(a.auth.methods.oauth.connections.remove(a.name));
  assert.equal((await json(await a.redeem(a.name, { ticket: pending.ticket, state: pending.state }), 400)).code, "invalid_code");
  await a.signIn();
});

test("upstream: a code redeems exactly once; an unknown code, another state or an expired ticket are INVALID_CODE", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  // Another state: invalid, and the ticket is preserved.
  assert.equal((await json(await a.redeem("acme", { ticket: f.ticket, state: "another-state" }), 400)).code, "invalid_code");
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1);
  assert.equal((await a.redeem("acme", { ticket: "unknown-code", state: f.state })).status, 400);
  // Another provider's name must not redeem it either.
  await a.configure("globex", { issuer: a.provider.origin });
  assert.equal((await a.redeem("globex", { ticket: f.ticket, state: f.state })).status, 400);
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1);
  assert.equal((await a.redeem("acme", { ticket: f.ticket, state: f.state })).status, 200);
  assert.equal((await json(await a.redeem("acme", { ticket: f.ticket, state: f.state }), 400)).code, "invalid_code");

  const late = await a.flow();
  a.clock.now += 2 * 60_000 + 1;
  assert.equal((await a.redeem("acme", { ticket: late.ticket, state: late.state })).status, 400);
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), [], "an expired ticket is deleted when presented");
});

test("concurrent redemptions of one ticket sign in once", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  const results = await Promise.all(Array.from({ length: 6 }, () => a.redeem("acme", { ticket: f.ticket, state: f.state })));
  assert.equal(results.filter((response) => response.status === 200).length, 1);
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);
  assert.equal((await a.rows(coreTables.sessions)).length, 1);
});

test("concurrent first sign-ins of one identity create one user", async (t) => {
  const a = await compose(t);
  const flows = await Promise.all(Array.from({ length: 4 }, () => a.flow()));
  const results = await Promise.all(flows.map((f) => a.redeem("acme", { ticket: f.ticket, state: f.state })));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);
  assert.equal((await a.rows(oauthTables.accounts)).length, 1);
});

test("upstream: the ticket payload is encrypted: the stored row holds neither the claims nor the code", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  const [ticket] = await a.rows(oauthFlowTables.tickets);
  assert.ok(!JSON.stringify(ticket).includes(f.ticket));
  assert.ok(!JSON.stringify(ticket).includes("person@example.test"));
  assert.ok(!JSON.stringify(ticket).includes("subject-1"));
});

test("browser pages of this origin get cookies, other clients get the token bundle", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  const response = await a.redeem("acme", { ticket: f.ticket, state: f.state }, { origin: ORIGIN });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tokens, undefined);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.ok(response.headers.getSetCookie().every((line) => /HttpOnly/i.test(line)));
});

// --- the callback's refusals (upstream components/oauth/http.test.ts) -----------------------------------------------

test("upstream: a request without state gets a bare 400; a repeated parameter gets 400; an unknown state gets 400", async (t) => {
  const a = await compose(t);
  assert.equal((await a.call("oauth/acme/callback?code=x")).status, 400);
  assert.equal((await a.call("oauth/acme/callback?state=a&state=b&code=x")).status, 400);
  const unknown = await a.call("oauth/acme/callback?state=never-issued&code=x");
  assert.equal(unknown.status, 400);
  assert.match(await unknown.text(), /expired or was already used/);
  assert.equal(unknown.headers.get("location"), null);
});

test("upstream: a replayed callback finds nothing left to claim", async (t) => {
  const a = await compose(t);
  const f = await a.flow();
  assert.equal((await a.call("", { url: f.authorized.callback })).status, 400);
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1, "the replay minted no second ticket");
});

test("upstream: an expired request redirects back to the app with expired", async (t) => {
  const a = await compose(t);
  const started = await json(await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO }), 200);
  a.clock.now += 10 * 60_000 + 1;
  const response = await a.call("", { url: a.provider.authorize(started.url).callback });
  assert.equal(response.status, 302);
  assert.equal(fragmentOf(response).fragment.get("error"), "expired");
  assert.deepEqual(await a.rows(oauthFlowTables.authorizationRequests), []);
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
});

test("upstream: access_denied passes through, any other provider error or a missing code is oauth_error", async (t) => {
  const a = await compose(t);
  assert.equal((await a.flow("acme", { error: "access_denied" })).error, "access_denied");
  assert.equal((await a.flow("acme", { error: "server_error", error_description: "no" })).error, "oauth_error");
  const started = await json(await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO }), 200);
  const response = await a.call(`oauth/acme/callback?state=${started.state}`);
  assert.equal(fragmentOf(response).fragment.get("error"), "oauth_error");
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
});

test("upstream: stale outcome params on redirectTo are replaced, app params kept", async (t) => {
  const a = await compose(t);
  const f = await a.flow("acme", { redirectTo: `${APP}/after?keep=1#ticket=stale&error=stale&route=/x` });
  const { location, fragment } = fragmentOf(f.response);
  assert.equal(location.searchParams.get("keep"), "1");
  assert.equal(fragment.get("route"), "/x");
  assert.equal(fragment.get("error"), null);
  assert.notEqual(fragment.get("ticket"), "stale");
  assert.ok(fragment.get("ticket"));
});

test("upstream: a failed token exchange redirects with oauth_error and mints no ticket; a token endpoint that redirects is refused", async (t) => {
  const a = await compose(t);
  a.provider.state.tokenStatus = 400;
  const failed = await a.flow();
  assert.equal(failed.error, "oauth_error");
  a.provider.state.tokenStatus = 200;
  a.provider.state.tokenRedirect = true;
  assert.equal((await a.flow()).error, "oauth_error");
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
  const failures = (await a.rows(securityTables.events)).filter((event) => event.kind === "authentication.failed");
  assert.deepEqual(failures.map((event) => event.detail), [
    { method: "oauth:acme", stage: "callback" }, { method: "oauth:acme", stage: "callback" },
  ]);
});

test("a provider that is down redirects with provider_unavailable", async (t) => {
  const a = await compose(t);
  a.provider.state.tokenStatus = 503;
  assert.equal((await a.flow()).error, "provider_unavailable");
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
});

test("a token endpoint that stalls past the timeout is aborted", async (t) => {
  const a = await compose(t);
  a.provider.state.tokenStall = true;
  const started = Date.now();
  const f = await a.flow();
  assert.equal(f.error, "provider_unavailable");
  assert.ok(Date.now() - started < 20_000);
});

test("id_token checks: another issuer, another audience, a bad nonce, an expired token and a foreign signature are refused", async (t) => {
  const a = await compose(t);
  const refused = async (bend, undo) => {
    bend();
    const f = await a.flow();
    undo();
    assert.equal(f.error, "oauth_error");
    assert.equal(f.ticket, undefined);
  };
  await refused(() => { a.provider.state.issuerClaim = "https://evil.example.test"; }, () => { a.provider.state.issuerClaim = undefined; });
  await refused(() => { a.provider.state.audience = "another-client"; }, () => { a.provider.state.audience = undefined; });
  await refused(() => { a.provider.state.nonceClaim = "another-nonce"; }, () => { a.provider.state.nonceClaim = undefined; });
  await refused(() => { a.provider.state.expiresInSeconds = -10; }, () => { a.provider.state.expiresInSeconds = 300; });
  const foreign = await a.provider.foreignKey();
  await refused(() => { a.provider.state.signingKey = foreign; }, () => undefined);
  assert.deepEqual(await a.rows(oauthFlowTables.tickets), []);
});

test("a flow with no id_token and no userinfo endpoints, or no subject, is refused", async (t) => {
  const a = await compose(t);
  a.provider.state.omitIdToken = true;
  assert.equal((await a.flow()).error, "oauth_error");
  a.provider.state.omitIdToken = false;
  a.provider.state.subject = "";
  assert.equal((await a.flow()).error, "oauth_error");
});

test("a callback of another provider's request is not exchanged with this provider's credentials", async (t) => {
  const a = await compose(t);
  await a.configure("globex", { issuer: a.provider.origin });
  const started = await json(await a.post("oauth/acme/start", { redirectTo: REDIRECT_TO }), 200);
  const response = await a.call("", { url: a.provider.authorize(started.url).callback.replace("/acme/", "/globex/") });
  assert.equal(fragmentOf(response).fragment.get("error"), "oauth_error");
  assert.equal(a.provider.requests.filter((r) => r.path === "/token").length, 0);
});

test("a callback for a name that is no provider is a 404; a posted callback to a GET-only provider is refused", async (t) => {
  const a = await compose(t);
  assert.equal((await a.call("oauth/Nobody!/callback?state=x")).status, 404);
  assert.equal((await a.call("oauth/connections/callback?state=x")).status, 404);
  const g = await compose(t, { kind: "google" });
  assert.equal((await g.call("", { method: "POST", url: `${ORIGIN}/auth/oauth/google/callback`, form: { state: "x", code: "y" } })).status, 405);
});

// --- Google, Apple and GitHub (upstream components/{google,apple,github}/http.test.ts) -----------------------------

test("upstream: google exchanges the code, accepts the issuer spelled without the https prefix, refuses another, and maps the profile", async (t) => {
  const a = await compose(t, { kind: "google" });
  a.provider.state.claims = { email: "g@example.test", email_verified: true, name: "G", hd: "example.test" };
  const bundle = await a.signIn();
  assert.equal((await a.rows(googleTables.accounts)).length, 1);
  const [session] = await a.rows(coreTables.sessions);
  assert.equal(session.component, "google");
  assert.ok(bundle.userId);
  a.provider.state.issuerClaim = "accounts.google.com";
  assert.equal((await a.flow()).error, undefined);
  a.provider.state.issuerClaim = "https://evil.example.test";
  assert.equal((await a.flow()).error, "oauth_error");
  assert.equal((await a.flow("google", { error: "access_denied" })).error, "access_denied");
});

test("upstream: apple posts its callback, signs its client secret, carries a sanitized name and treats user_cancelled_authorize as access_denied", async (t) => {
  const a = await compose(t, { kind: "apple" });
  a.provider.state.claims = { email: "relay@privaterelay.appleid.com", email_verified: "true" };
  const f = await a.flow("apple", { userField: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "forged@evil.test" }) });
  assert.equal(f.response.status, 303, "a posted callback redirects with 303");
  assert.ok(f.ticket);
  const exchange = a.provider.requests.find((r) => r.path === "/token");
  const { decodeJwt, decodeProtectedHeader } = await import("jose");
  const secret = decodeJwt(exchange.form.client_secret);
  assert.equal(secret.iss, "TEAM123456");
  assert.equal(secret.sub, "client-1");
  assert.equal(secret.aud, "https://appleid.apple.com");
  assert.equal(decodeProtectedHeader(exchange.form.client_secret).kid, "KEY1234567");
  assert.equal(decodeProtectedHeader(exchange.form.client_secret).alg, "ES256");
  assert.ok(secret.exp - secret.iat <= 300);
  assert.equal((await a.redeem("apple", { ticket: f.ticket, state: f.state })).status, 200);
  assert.equal((await a.flow("apple", { error: "user_cancelled_authorize" })).error, "access_denied");
  // A form that carries a query is read for its fields only, and a posted callback must be a form.
  const started = await json(await a.post("oauth/apple/start", { redirectTo: REDIRECT_TO }), 200);
  const authorized = a.provider.authorize(started.url);
  const notForm = await a.call("", { method: "POST", url: authorized.params.redirect_uri, body: { state: authorized.fields.state, code: authorized.fields.code } });
  assert.equal(notForm.status, 400);
});

test("upstream: github fetches both userinfo endpoints, refuses a token response with no access_token and a failing userinfo", async (t) => {
  const a = await compose(t, { kind: "github" });
  const bundle = await a.signIn();
  assert.ok(bundle.userId);
  assert.equal((await a.rows(githubTables.accounts)).length, 1);
  const userinfo = a.provider.requests.filter((r) => r.path.startsWith("/userinfo"));
  assert.deepEqual(userinfo.map((r) => r.path).sort(), ["/userinfo/emails", "/userinfo/user"]);
  assert.ok(userinfo.every((r) => r.authorization === "Bearer access-token-1"));
  a.provider.state.omitAccessToken = true;
  assert.equal((await a.flow()).error, "oauth_error");
  a.provider.state.omitAccessToken = false;
  a.provider.state.userinfoStatus = 500;
  assert.equal((await a.flow()).error, "provider_unavailable");
});

// --- linking ----------------------------------------------------------------------------------------------------------

test("a signed-in caller links a provider account; it signs in as that account afterwards; no session is created by linking", async (t) => {
  const a = await compose(t, { kind: "github" });
  const bundle = await a.run(bindTestMethod(a.auth).signUp());
  const f = await a.flow();
  const sessionsBefore = (await a.rows(coreTables.sessions)).length;
  const linked = await a.redeem("github", { ticket: f.ticket, state: f.state, link: true }, a.bearer(bundle));
  assert.equal(linked.status, 204);
  assert.equal((await a.rows(coreTables.sessions)).length, sessionsBefore);
  assert.equal((await a.rows(accountsTables.accounts)).length, 1, "linking creates no account");
  const [link] = await a.rows(githubTables.accounts);
  assert.equal(link.userId, bundle.userId);
  // The same provider account now signs in as the linked user.
  const again = await a.signIn();
  assert.equal(again.userId, bundle.userId);
  // Linking the same account again is a no-op for the same user.
  const second = await a.flow();
  assert.equal((await a.redeem("github", { ticket: second.ticket, state: second.state, link: true }, a.bearer(bundle))).status, 204);
  assert.equal((await a.rows(githubTables.accounts)).length, 1);
});

test("a provider account linked elsewhere is refused with 409 provider_account_in_use, and the other account is untouched", async (t) => {
  const a = await compose(t, { kind: "github" });
  const owner = await a.run(bindTestMethod(a.auth).signUp());
  const intruder = await a.run(bindTestMethod(a.auth, "intruder").signUp());
  const first = await a.flow();
  assert.equal((await a.redeem("github", { ticket: first.ticket, state: first.state, link: true }, a.bearer(owner))).status, 204);
  const second = await a.flow();
  const refused = await a.redeem("github", { ticket: second.ticket, state: second.state, link: true }, a.bearer(intruder));
  assert.equal((await refused.json()).code, "provider_account_in_use");
  assert.equal(refused.status, 409);
  const [link] = await a.rows(githubTables.accounts);
  assert.equal(link.userId, owner.userId);
});

test("linking needs a signed-in caller and does not spend the ticket without one", async (t) => {
  const a = await compose(t, { kind: "github" });
  const f = await a.flow();
  const anonymous = await a.redeem("github", { ticket: f.ticket, state: f.state, link: true });
  assert.equal(anonymous.status, 401);
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 1);
  assert.equal((await a.rows(githubTables.accounts)).length, 0);
});

// --- the sweep (closing upstream's known issue) -------------------------------------------------------------------------

test("abandoned authorization requests and tickets are removed by the sweep, 200 a run", async (t) => {
  const a = await compose(t);
  const sweep = createExpiredFlowsSweep(a.tenant, () => a.clock.now);
  const insertRows = (count, expiresAt, table, extra) => a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
    for (let i = 0; i < count; i += 1) yield* tx.db.insert(table, { ...extra(i), expiresAt: expiresAt + i });
  })));
  const past = a.clock.now - 60_000;
  for (let batch = 0; batch < 5; batch += 1) {
    await insertRows(50, past, oauthFlowTables.authorizationRequests, (i) => ({ providerName: "acme", connectionRevision: "test", stateHash: `s${batch}-${i}`, redirectTo: REDIRECT_TO, callbackUrl: "x", codeVerifier: "v" }));
  }
  // Live rows, and a few expired tickets, must be treated as they are.
  await insertRows(3, a.clock.now + 60_000, oauthFlowTables.authorizationRequests, (i) => ({ providerName: "acme", connectionRevision: "test", stateHash: `live${i}`, redirectTo: REDIRECT_TO, callbackUrl: "x", codeVerifier: "v" }));
  await insertRows(10, past, oauthFlowTables.tickets, (i) => ({ providerName: "acme", connectionRevision: "test", stateHash: `t${i}`, ticketCodeHash: `c${i}`, encryptedPayload: "p" }));
  assert.equal((await a.rows(oauthFlowTables.authorizationRequests)).length, 253);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 200);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 60, "the remaining 50 requests and the 10 tickets");
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 0);
  assert.equal((await a.rows(oauthFlowTables.authorizationRequests)).length, 3, "live requests stay");
  assert.equal((await a.rows(oauthFlowTables.tickets)).length, 0);
  // After a full refill period an idle flow is gone and a fresh one still works.
  assert.equal((await a.signIn()).status, "complete");
});
