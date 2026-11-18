/**
 * Zelavis Auth test harness: one Auth partition in a throwaway database, a
 * runtime with a settable clock and a fixed master secret, and a recording
 * email outbox.
 */
import { Effect } from "effect";
import { openTemporaryDatabase } from "./_database.mjs";
import { createAuthRuntime } from "../dist/auth/runtime/index.js";
import { EmailDisabled } from "../dist/app/email/errors.js";

export const AUTH_TENANT = "service:zelavis-auth";
export const TEST_MASTER_SECRET = "zelavis-auth-test-master-secret";

/** `{ database, tenant }`: the Auth partition of a temporary database. */
export async function openAuthTestTenant(t, { engine } = {}) {
  const opened = await openTemporaryDatabase(t, engine === undefined ? {} : { engine: { name: engine } });
  return { database: opened.database, tenant: opened.database.forTenant(AUTH_TENANT) };
}

/**
 * An `EmailOutbox` that records what it is given and delivers once per id, as
 * the real one does. `disabled = true` makes it refuse with `EmailDisabled`.
 */
export function recordingOutbox() {
  const ids = new Set();
  const outbox = {
    delivered: [],
    disabled: false,
    enqueue: (message) => Effect.suspend(() => {
      if (outbox.disabled) return Effect.fail(new EmailDisabled({ message: "Email is disabled." }));
      if (!ids.has(message.id)) {
        ids.add(message.id);
        outbox.delivered.push(message);
      }
      return Effect.succeed({ id: message.id });
    }),
    // `undefined` makes email delivery unavailable, as a runtime with email disabled reports.
    linkBaseUrl: new URL("https://example.test/"),
    linkBase: () => Effect.sync(() => outbox.linkBaseUrl),
  };
  return outbox;
}

/** Polls until `predicate()` holds (the outbox relay delivers after the commit, on its own fiber). */
export async function waitFor(predicate, { timeoutMs = 5000, what = "the condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The code in the fragment of the link in a delivered message's text, and the page it opens. */
export function emailLinkOf(message) {
  const match = /(https?:\/\/\S+?)#code=([A-Za-z0-9_-]+)/.exec(message.text);
  if (match === null) throw new Error(`No link in ${message.text}`);
  return { page: new URL(match[1]).pathname, code: match[2] };
}

/** A runtime over `tenant` whose clock is `clock.now` (milliseconds; set it to move time). */
export function authTestRuntime(tenant, { now = 1_700_000_000_000, relay } = {}) {
  const clock = { now };
  const runtime = createAuthRuntime({ tenant, masterSecret: TEST_MASTER_SECRET, clock: () => clock.now, relay });
  return { runtime, clock };
}

// --- Zelavis Auth core (part 5) -------------------------------------------

import { Logger } from "effect";
import { createAuth } from "../dist/auth/create-auth.js";
import { createCoreRuntime, signUpRolesFor } from "../dist/auth/core/context.js";
import { bootstrapTables } from "../dist/auth/bootstrap/tables.js";

/**
 * One Auth instance over a throwaway Auth partition: `clock.now` is its time (set it to move time), `core` runs
 * ported mutations and queries (`core.mutation(call, tx => ...)`), `logs` collects what Auth logs (one string each).
 */
export async function openAuth(t, {
  now = 1_700_000_000_000, ttl, role = "platform", projectId, apiBase, emailOutbox, oauth, passkeys,
  // Most cases sign up freely: registration starts open and, on the Platform, the first owner counts as claimed.
  // `registration: false` keeps the runtime's real default (closed); `bootstrapped: false` leaves the claim open.
  registration = true, bootstrapped = true, bootstrapToken, validateGrantScopes,
} = {}) {
  const { database, tenant } = await openAuthTestTenant(t);
  const clock = { now };
  const logs = [];
  const logger = Logger.make(({ message, logLevel }) => { logs.push({ level: logLevel, text: [message].flat().join(" ") }); });
  const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([logger]))));
  const auth = await run(createAuth({
    tenant, masterSecret: TEST_MASTER_SECRET, role, projectId, ttl, apiBase, emailOutbox, oauth, passkeys, clock: () => clock.now,
    registration: { initiallyEnabled: registration }, bootstrapToken, validateGrantScopes,
  }));
  if (role === "platform" && bootstrapped) {
    await run(auth.runtime.mutation({ ip: null }, (tx) => tx.db.insert(bootstrapTables.claims, { accountId: "test-owner" })));
  }
  return { auth, tenant, database, clock, logs, run, core: createCoreRuntime(auth.runtime, auth.keys, signUpRolesFor(role)) };
}

/** The name `signUp`/`signIn` bind under; the session records it as its `component`. */
export const TEST_METHOD = "testMethod";

/**
 * A method bound to the core, as a sign-in method of a later part is: `signUp()` verifies nobody and calls
 * `completeSignUp`; `signIn(userId)` calls `completeSignIn`. Both run as one transaction and answer the token bundle.
 */
export function bindTestMethod(auth, name = TEST_METHOD, callbacks = {}) {
  const bound = auth.core.bindMethod({
    name,
    createUser: callbacks.createUser ?? auth.accounts.createUser,
    onSignIn: "onSignIn" in callbacks ? callbacks.onSignIn : auth.accounts.onSignIn,
  });
  const call = (request) => ({ ip: null, ...request });
  return {
    bound,
    signUp: (profile = {}, request) => bound.mutation(call(request), (tx, helpers) => helpers.completeSignUp(tx, { profile, authenticatedBy: name })),
    // `completeSignIn` answers an outcome; a complete one is reduced to its bundle, a gated one is answered as it is.
    signIn: (userId, profile = {}, request) => bound.mutation(call(request), (tx, helpers) => helpers.completeSignIn(tx, { userId, profile, authenticatedBy: name }).pipe(
      Effect.map((outcome) => (outcome.status === "complete" ? outcome.tokens : outcome)),
    )),
  };
}

// --- OAuth (part 8) -------------------------------------------------------

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const sha256Base64Url = (value) => createHash("sha256").update(value).digest("base64url");

/** The hosts of the built-in providers' hard-coded endpoints, and where on the fake provider each one lands. */
const BUILT_IN_ENDPOINTS = {
  "https://oauth2.googleapis.com/token": "/token",
  "https://appleid.apple.com/auth/token": "/token",
  "https://github.com/login/oauth/access_token": "/token",
  "https://api.github.com/user": "/userinfo/user",
  "https://api.github.com/user/emails": "/userinfo/emails",
};

const DEFAULT_ISSUERS = { google: "https://accounts.google.com", apple: "https://appleid.apple.com" };

/**
 * A fake identity provider: a local HTTP server with the token, key set, userinfo and discovery endpoints, and a
 * `fetch` that sends the built-in providers' real URLs (Google's token endpoint, GitHub's API, ...) to it.
 *
 * `authorize(url)` plays the browser: it takes the authorization URL a `start` returned, checks it as a provider
 * would, and answers the callback URL (or form) the provider would send the browser to. The `/token` endpoint checks
 * PKCE, the redirect URI and the client id, so a wrong flow fails here as it would at the real provider. Everything a
 * test may want to bend is a field of `provider.state`.
 */
export async function fakeOAuthProvider(t, { kind = "oidc", now = Date.now } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "fake-key", alg: "RS256", use: "sig" };
  const appleKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  const state = {
    clientId: "client-1",
    clientSecret: kind === "apple" ? appleKey : "client-secret-1",
    subject: "subject-1",
    claims: { email: "person@example.test", email_verified: true, name: "Person One" },
    accessToken: "access-token-1",
    /** Set by a test to bend a response: status of /token, /userinfo, a redirecting token endpoint, no id_token, ... */
    tokenStatus: 200,
    tokenRedirect: false,
    tokenStall: false,
    omitIdToken: false,
    omitAccessToken: false,
    userinfoStatus: 200,
    issuerClaim: undefined,
    audience: undefined,
    nonceClaim: undefined,
    expiresInSeconds: 300,
    signingKey: privateKey,
    discoveryIssuer: undefined,
    userinfo: {
      user: { id: 1001, login: "octocat", name: "The Octocat", email: "public@example.test", avatar_url: "https://avatars.example.test/1" },
      emails: [
        { email: "secondary@example.test", primary: false, verified: true },
        { email: "primary@example.test", primary: true, verified: true },
      ],
    },
  };
  const codes = new Map();
  const requests = [];
  let origin = "";

  const readBody = (request) => new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const send = (response, status, body, headers = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    const body = request.method === "POST" ? await readBody(request) : "";
    requests.push({ method: request.method, path: url.pathname, form: body === "" ? undefined : Object.fromEntries(new URLSearchParams(body)), authorization: request.headers.authorization });
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(response, 200, {
        issuer: state.discoveryIssuer ?? origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        jwks_uri: `${origin}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url.pathname === "/jwks") return send(response, 200, { keys: [jwk] });
    if (url.pathname === "/token") {
      if (state.tokenStall) return undefined;
      if (state.tokenRedirect) return send(response, 302, undefined, { location: `${origin}/elsewhere` });
      if (state.tokenStatus !== 200) return send(response, state.tokenStatus, { error: "server_error" });
      const form = Object.fromEntries(new URLSearchParams(body));
      const entry = codes.get(form.code);
      if (entry === undefined || entry.used) return send(response, 400, { error: "invalid_grant" });
      entry.used = true;
      if (form.redirect_uri !== entry.redirectUri || form.client_id !== state.clientId || sha256Base64Url(form.code_verifier ?? "") !== entry.challenge) {
        return send(response, 400, { error: "invalid_grant" });
      }
      if (kind !== "apple" && form.client_secret !== state.clientSecret) return send(response, 401, { error: "invalid_client" });
      const tokens = {};
      if (!state.omitAccessToken) tokens.access_token = state.accessToken;
      if (kind !== "github" && !state.omitIdToken) {
        const issued = Math.floor(now() / 1000);
        tokens.id_token = await new SignJWT({ ...state.claims, ...(entry.nonce === undefined && state.nonceClaim === undefined ? {} : { nonce: state.nonceClaim ?? entry.nonce }) })
          .setProtectedHeader({ alg: "RS256", kid: "fake-key" })
          .setIssuer(state.issuerClaim ?? DEFAULT_ISSUERS[kind] ?? origin)
          .setAudience(state.audience ?? state.clientId)
          .setSubject(state.subject)
          .setIssuedAt(issued)
          .setExpirationTime(issued + state.expiresInSeconds)
          .sign(state.signingKey);
      }
      return send(response, 200, tokens);
    }
    if (url.pathname === "/userinfo/user" || url.pathname === "/userinfo/emails") {
      if (request.headers.authorization !== `Bearer ${state.accessToken}`) return send(response, 401, { message: "Bad credentials" });
      if (state.userinfoStatus !== 200) return send(response, state.userinfoStatus, { message: "unavailable" });
      return send(response, 200, url.pathname === "/userinfo/user" ? state.userinfo.user : state.userinfo.emails);
    }
    return send(response, 404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });

  const provider = {
    state,
    origin,
    requests,
    /** The signing key set an OpenID Connect connection verifies against; `foreignKey()` makes a token it cannot verify. */
    foreignKey: async () => (await generateKeyPair("RS256")).privateKey,
    /** A `fetch` for `createAuth({ oauth: { fetch } })`: loopback URLs go through, the built-in providers' URLs land here. */
    fetch: (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const mapped = BUILT_IN_ENDPOINTS[url];
      if (mapped !== undefined) return fetch(`${origin}${mapped}`, init);
      if (url.startsWith(origin)) return fetch(url, init);
      return Promise.reject(new Error(`The fake provider got a request to ${url}`));
    },
    /** What the provider checks when the browser arrives with an authorization URL, and the callback it answers. */
    authorize(authorizationUrl, { error, errorDescription } = {}) {
      const url = new URL(authorizationUrl);
      const params = Object.fromEntries(url.searchParams);
      if (params.client_id !== state.clientId) throw new Error(`Unknown client ${params.client_id}`);
      if (params.response_type !== "code" || params.code_challenge_method !== "S256" || params.code_challenge === undefined) throw new Error("Not an authorization-code request with S256 PKCE");
      const code = randomBytes(16).toString("hex");
      codes.set(code, { redirectUri: params.redirect_uri, challenge: params.code_challenge, nonce: params.nonce });
      const fields = error === undefined ? { code, state: params.state } : { error, ...(errorDescription === undefined ? {} : { error_description: errorDescription }), state: params.state };
      const query = new URLSearchParams(fields).toString();
      return { params, code, callback: `${params.redirect_uri}?${query}`, fields, formPost: params.response_mode === "form_post" };
    },
  };
  return provider;
}

/** The `#ticket=` and `#error=` of a callback redirect. */
export function fragmentOf(response) {
  const location = new URL(response.headers.get("location"));
  return { location, fragment: new URLSearchParams(location.hash.replace(/^#/, "")) };
}

// --- Zelavis account modules over HTTP (part 11) ---------------------------

import { createServiceRuntime } from "../dist/core/index.js";
import { setRequestClientAddress } from "../dist/core/runtime/client-address.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";

/**
 * `openAuth` composed the way a runtime composes it, with every route under `/auth`: `call(path, { method, body,
 * headers })` sends a request from `client.address` (set it to be another client; `null` for none), `bearer(tokens)`
 * is the header of a token bundle (or a raw token string), `rows(table)` reads a table, `documents(table)` its raw
 * stored documents. Sweeps and the outbox relay run while the test does.
 */
export async function composeAuth(t, options = {}) {
  const a = await openAuth(t, options);
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
  const client = { address: "198.51.100.7" };
  const origin = options.origin ?? "https://auth.example.test";
  const call = (path, { method = "GET", headers = {}, body } = {}) => {
    const request = new Request(`${origin}/auth/${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (client.address !== null) setRequestClientAddress(request, client.address);
    return runtime.fetch(request);
  };
  const bearer = (tokens) => ({ authorization: `Bearer ${typeof tokens === "string" ? tokens : tokens.accessToken}` });
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const documents = (table) => a.run(a.tenant.documents.findMany({ collection: table.collection, limit: 1000 }));
  return { ...a, runtime, client, call, bearer, rows, documents };
}

/** Asserts the status and answers the JSON body (or null for an empty one). */
export async function expectStatus(response, status) {
  const text = await response.text();
  if (response.status !== status) throw new Error(`expected ${status}, got ${response.status}: ${text}`);
  return text === "" ? null : JSON.parse(text);
}
