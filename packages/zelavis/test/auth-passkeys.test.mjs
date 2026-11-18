import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { createServiceRuntime } from "../dist/core/index.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { setRequestClientAddress } from "../dist/core/runtime/client-address.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { securityTables } from "../dist/auth/security/tables.js";
import { passkeyTables } from "../dist/auth/passkey/tables.js";
import { createExpiredPasskeyChallengesSweep } from "../dist/auth/passkey/cleanup.js";
import { CHALLENGE_TTL_MS, SUPPORTED_ALGORITHM_IDS } from "../dist/auth/passkey/constants.js";
import { defaultPasskeyName } from "../dist/auth/methods/username-passkey/aaguids.js";
import { fromBase64URL, toBase64URL } from "../dist/auth/methods/username-passkey/base64url.js";
import { buildAuthenticationOptions, buildRegistrationOptions } from "../dist/auth/methods/username-passkey/options.js";
import { openAuth } from "./_auth.mjs";
import {
  aaguidBytes, buildAssertion, buildAttestationObject, buildAuthenticatorData, buildClientDataJSON,
  generateES256Credential, generateRS256Credential, registrationResponse,
} from "./fixtures/passkey-authenticator/index.ts";

const ORIGIN = "https://app.example.test";
const RP_ID = "app.example.test";
const SETTINGS = { rpId: RP_ID, rpName: "App", origins: [ORIGIN] };

async function compose(t, defaults = { publicOrigins: [ORIGIN], name: "App" }) {
  const a = await openAuth(t, { passkeys: defaults });
  const runtime = await createServiceRuntime({ endpointGroups: [{
    id: "auth", basePath: "/auth", api: { v1: a.auth.routes }, context: a.auth,
    authenticators: [a.auth.requestAuthenticator], origin: { type: "subsystem", subsystem: "auth-test" },
  }] });
  const client = { address: "192.0.2.10" };
  const call = (path, { method = "GET", body, token, headers = {}, origin = ORIGIN } = {}) => {
    const request = new Request(`${origin}/auth/${path}`, {
      method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    setRequestClientAddress(request, client.address);
    return runtime.fetch(request);
  };
  const post = (path, body, token) => call(path, { method: "POST", body, token });
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const mutate = (f) => a.run(a.auth.runtime.mutation(NO_REQUEST, f));
  return { ...a, call, post, rows, mutate, client };
}

async function json(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, body.code ?? "Unexpected HTTP status");
  return body;
}

async function registration(options, credential, { origin = ORIGIN, rpId = RP_ID, crossOrigin, userPresent, userVerified, aaguid, type = "webauthn.create", challenge = options.challenge, transports } = {}) {
  return registrationResponse({
    credential, transports,
    clientDataJSON: buildClientDataJSON({ type, challenge, origin, crossOrigin }),
    attestationObject: buildAttestationObject(await buildAuthenticatorData({ rpId, credential, userPresent, userVerified, aaguid })),
  });
}

async function assertion(started, credential, { handle, ...parameters } = {}) {
  const { response } = await buildAssertion(credential, started.options.challenge, { origin: ORIGIN, rpId: RP_ID, ...parameters });
  if (handle !== undefined) response.response.userHandle = handle;
  return { flowId: started.flowId, response };
}

async function signUp(a, username, credential = undefined) {
  credential ??= await generateES256Credential();
  const started = await json(await a.post("username-passkey/sign-up/start", { username }));
  const response = await registration(started.options, credential);
  const { tokens } = await json(await a.post("username-passkey/sign-up/finish", { flowId: started.flowId, response }));
  return { credential, tokens, handle: started.options.user.id };
}

async function beginAdd(a, { credential, tokens }) {
  const started = await json(await a.post("passkeys/add/start", {}, tokens.accessToken));
  return json(await a.post("passkeys/add/verify", await assertion(started, credential), tokens.accessToken));
}

test("upstream option vectors match SimpleWebAuthn base64url and pin the ceremony parameters", () => {
  for (let length = 0; length < 130; length += 1) {
    const buffer = Uint8Array.from({ length }, (_, index) => (index * 7 + length) % 256);
    assert.equal(toBase64URL(buffer.buffer), isoBase64URL.fromBuffer(buffer));
    assert.deepEqual(new Uint8Array(fromBase64URL(toBase64URL(buffer.buffer))), buffer);
  }
  const challenge = Uint8Array.of(0xfb, 0xff).buffer;
  const descriptor = { id: challenge, transports: ["internal"] };
  const result = buildRegistrationOptions({ rpId: RP_ID, rpName: "App", challenge, userHandle: challenge, userName: "Alice", userDisplayName: "Alice", excludeCredentials: [descriptor] });
  assert.equal(result.challenge, "-_8");
  assert.deepEqual(result.rp, { id: RP_ID, name: "App" });
  assert.deepEqual(result.user, { id: "-_8", name: "Alice", displayName: "Alice" });
  assert.equal(result.timeout, CHALLENGE_TTL_MS - 60_000);
  assert.deepEqual(result.pubKeyCredParams.map(({ alg }) => alg), SUPPORTED_ALGORITHM_IDS);
  assert.deepEqual(result.authenticatorSelection, { residentKey: "required", requireResidentKey: true, userVerification: "required" });
  assert.equal(result.attestation, "none");
  assert.deepEqual(result.extensions, {});
  assert.deepEqual(result.excludeCredentials, [{ id: "-_8", type: "public-key", transports: ["internal"] }]);
  assert.deepEqual(buildAuthenticationOptions({ rpId: RP_ID, challenge, allowCredentials: [] }).allowCredentials, []);
  assert.deepEqual(buildAuthenticationOptions({ rpId: RP_ID, challenge, allowCredentials: [descriptor] }).allowCredentials, result.excludeCredentials);
});

test("upstream AAGUID vectors name known authenticators and handle unknown or malformed attestations", async () => {
  const credential = await generateES256Credential();
  const options = { challenge: "AQID" };
  for (const [aaguid, expected] of [
    ["bada5566-a7aa-401f-bd96-45619a55120d", "1Password"],
    ["fbfc3007-154e-4ecc-8c0b-6e020557d7bd", "Apple Passwords"],
    ["00000000-0000-0000-0000-000000000000", undefined],
  ]) {
    assert.equal(defaultPasskeyName(await registration(options, credential, { aaguid: aaguidBytes(aaguid) })), expected);
  }
  const malformed = await registration(options, credential);
  malformed.response.attestationObject = "AQID";
  assert.equal(defaultPasskeyName(malformed), undefined);
});

test("a distinct configured origin for the same RP can register and authenticate", async (t) => {
  const alternate = `https://login.${RP_ID}`;
  const a = await compose(t, { publicOrigins: [ORIGIN, alternate] });
  const credential = await generateES256Credential();
  const started = await json(await a.post("username-passkey/sign-up/start", { username: "Alice" }));
  const response = await registration(started.options, credential, { origin: alternate, transports: ["internal", "hybrid"] });
  const { userId } = await json(await a.post("username-passkey/sign-up/finish", { flowId: started.flowId, response }));
  const signingIn = await json(await a.post("username-passkey/sign-in/start", { username: "Alice" }));
  assert.deepEqual(signingIn.options.allowCredentials[0].transports, ["internal", "hybrid"]);
  assert.equal((await json(await a.post("username-passkey/sign-in/finish", await assertion(signingIn, credential, { origin: alternate })))).userId, userId);
});

for (const [algorithm, generate] of [["ES256", generateES256Credential], ["RS256", generateRS256Credential]]) {
  test(`${algorithm}: register, sign in by username and autofill, reject challenge reuse`, async (t) => {
    const a = await compose(t);
    const user = await signUp(a, "Alice", await generate());
    assert.equal((await a.rows(passkeyTables.passkeys)).length, 1);
    assert.equal((await a.rows(passkeyTables.handles)).length, 1);
    assert.equal((await a.rows(passkeyTables.challenges)).length, 0);
    assert.equal((await a.rows(accountsTables.accounts)).length, 1);
    const started = await json(await a.post("username-passkey/sign-in/start", { username: "aLIce" }));
    assert.equal(started.options.allowCredentials.length, 1);
    const proof = await assertion(started, user.credential, { counter: 0 });
    const signed = await json(await a.post("username-passkey/sign-in/finish", proof));
    assert.equal(signed.userId, user.tokens.userId);
    assert.equal((await json(await a.post("username-passkey/sign-in/finish", proof), 400)).code, "challenge_expired");
    const autofill = await json(await a.post("username-passkey/sign-in/autofill", {}));
    assert.deepEqual(autofill.options.allowCredentials, []);
    assert.equal((await json(await a.post("username-passkey/sign-in/finish", await assertion(autofill, user.credential)), 400)).code, "protocol_error");
    const discovered = await json(await a.post("username-passkey/sign-in/finish", await assertion(autofill, user.credential, { handle: user.handle })));
    assert.equal(discovered.userId, user.tokens.userId);
  });
}

test("registration rejects wrong origin, RP, challenge, operation type, cross-origin and absent verification", async (t) => {
  const a = await compose(t);
  const credential = await generateES256Credential();
  const started = await json(await a.post("username-passkey/sign-up/start", { username: "Alice" }));
  for (const parameters of [{ origin: "https://other.example.test" }, { rpId: "other.example.test" },
    { challenge: "AQID" }, { type: "webauthn.get" }, { crossOrigin: true }, { userVerified: false }, { userPresent: false }]) {
    const response = await registration(started.options, credential, parameters);
    assert.equal((await json(await a.post("username-passkey/sign-up/finish", { flowId: started.flowId, response }), 400)).code, "protocol_error");
  }
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
  assert.equal((await a.rows(passkeyTables.passkeys)).length, 0);
});

test("assertions enforce signature, origin, RP, challenge, operation type, verification and user binding", async (t) => {
  const a = await compose(t);
  const alice = await signUp(a, "Alice");
  const bob = await signUp(a, "Bob");
  const started = await json(await a.post("username-passkey/sign-in/start", { username: "Alice" }));
  for (const parameters of [{ signWith: bob.credential }, { origin: "https://wrong.example.test" }, { rpId: "wrong.example.test" },
    { type: "webauthn.create" }, { crossOrigin: true }, { userVerified: false }, { userPresent: false }, { handle: bob.handle }]) {
    assert.equal((await json(await a.post("username-passkey/sign-in/finish", await assertion(started, alice.credential, parameters)), 400)).code, "protocol_error");
  }
  assert.equal((await json(await a.post("username-passkey/sign-in/finish", await assertion(started, bob.credential)), 400)).code, "protocol_error");
  const mismatched = await assertion({ ...started, options: { ...started.options, challenge: "AQID" } }, alice.credential);
  assert.equal((await json(await a.post("username-passkey/sign-in/finish", mismatched), 400)).code, "protocol_error");
  assert.equal((await a.rows(coreTables.sessions)).length, 2);
  const failures = (await a.rows(securityTables.events)).filter((event) => event.kind === "authentication.failed");
  assert.equal(failures.length, 10);
  assert.ok(failures.every((event) => event.detail.method === "usernamePasskey" && !JSON.stringify(event).includes(started.flowId)));
});

test("concurrent registration of one username commits exactly one account, handle, passkey and session", async (t) => {
  const a = await compose(t);
  const starts = await Promise.all(["Alice", "alice"].map(async (username) => json(await a.post("username-passkey/sign-up/start", { username }))));
  const requests = await Promise.all(starts.map(async (start) => ({ flowId: start.flowId, response: await registration(start.options, await generateES256Credential()) })));
  const results = await Promise.all(requests.map((request) => a.post("username-passkey/sign-up/finish", request)));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  for (const table of [accountsTables.accounts, coreTables.sessions, passkeyTables.passkeys, passkeyTables.handles]) assert.equal((await a.rows(table)).length, 1);
});

test("manage passkeys with fresh proof, preserve ownership, and refuse self-removal and the last passkey", async (t) => {
  const a = await compose(t);
  const user = await signUp(a, "Alice");
  const other = await signUp(a, "Bob");
  const token = user.tokens.accessToken;
  const listed = () => a.call("passkeys", { token }).then((response) => json(response)).then(({ passkeys }) => passkeys);
  const [first] = await listed();
  const removePath = `passkeys/${first.passkeyId}/remove`;
  assert.equal((await json(await a.post(`${removePath}/start`, {}, token), 409)).code, "last_passkey");
  assert.equal((await json(await a.call(`passkeys/${first.passkeyId}`, { method: "PATCH", body: { name: "Stolen" }, token: other.tokens.accessToken }), 404)).code, "passkey_not_found");
  const add = await beginAdd(a, user);
  assert.equal(add.options.user.id, user.handle, "additional passkeys use the same RP user handle");
  const second = await generateES256Credential();
  const registered = await json(await a.post("passkeys/add/finish", { flowId: add.flowId, response: await registration(add.options, second) }, token));
  for (const name of ["   ", "Hidden\u202e", "Control\n", "a".repeat(51)]) {
    assert.equal((await json(await a.call(`passkeys/${registered.passkeyId}`, { method: "PATCH", body: { name }, token }), 400)).code, "invalid_passkey_name");
  }
  await json(await a.call(`passkeys/${registered.passkeyId}`, { method: "PATCH", body: { name: "Security key" }, token }));
  assert.equal((await listed()).find((value) => value.passkeyId === registered.passkeyId).name, "Security key");
  const removal = await json(await a.post(`${removePath}/start`, {}, token));
  assert.equal(removal.options.allowCredentials.length, 1);
  assert.equal((await json(await a.post(`${removePath}/finish`, await assertion(removal, user.credential), token), 400)).code, "protocol_error");
  await json(await a.post(`${removePath}/finish`, await assertion(removal, second), token));
  assert.deepEqual((await listed()).map(({ passkeyId }) => passkeyId), [registered.passkeyId]);
});

test("ceremony rate limits and HTTP input bounds apply before verification", async (t) => {
  const a = await compose(t);
  assert.equal((await json(await a.post("username-passkey/sign-up/finish", { flowId: "malformed", response: {} }), 400)).code, "invalid_request");
  assert.equal((await a.post("username-passkey/sign-up/start", { username: "a".repeat(17_000) })).status, 413);
  for (let attempt = 0; attempt < 30; attempt += 1) await json(await a.post("username-passkey/sign-in/autofill", {}));
  const limited = await a.post("username-passkey/sign-in/autofill", {});
  assert.equal((await json(limited, 429)).code, "rate_limited");
  assert.ok(limited.headers.has("retry-after"));
  a.client.address = "192.0.2.11";
  await json(await a.post("username-passkey/sign-in/autofill", {}));
});

test("adding a passkey enforces credential uniqueness and checks the enrollment limit again at finish", async (t) => {
  const a = await compose(t);
  const user = await signUp(a, "Alice");
  const token = user.tokens.accessToken;
  const add = await beginAdd(a, user);
  assert.equal((await json(await a.post("passkeys/add/finish", { flowId: add.flowId, response: await registration(add.options, user.credential) }, token), 409)).code, "credential_already_registered");
  const [original] = await a.rows(passkeyTables.passkeys);
  const { _id, _creationTime, ...fields } = original;
  await a.mutate((tx) => Effect.gen(function* () {
    for (let index = 0; index < 19; index += 1) yield* tx.db.insert(passkeyTables.passkeys, { ...fields, credentialId: `extra_${index}` });
  }));
  assert.equal((await json(await a.post("passkeys/add/finish", { flowId: add.flowId, response: await registration(add.options, await generateES256Credential()) }, token), 409)).code, "too_many_passkeys");
  assert.equal((await json(await a.post("passkeys/add/start", {}, token), 409)).code, "too_many_passkeys");
  assert.equal((await a.rows(passkeyTables.passkeys)).length, 20);
});

test("passkey management binds re-authentication to the initiating session", async (t) => {
  const a = await compose(t);
  const user = await signUp(a, "Alice");
  const add = await beginAdd(a, user);
  const auth = await json(await a.post("username-passkey/sign-in/start", { username: "Alice" }));
  const { tokens } = await json(await a.post("username-passkey/sign-in/finish", await assertion(auth, user.credential)));
  const proof = { flowId: add.flowId, response: await registration(add.options, await generateES256Credential()) };
  assert.equal((await json(await a.post("passkeys/add/finish", proof, tokens.accessToken), 400)).code, "protocol_error");
  await json(await a.post("passkeys/add/finish", proof, user.tokens.accessToken));
});

test("a revoked session cannot finish adding a passkey", async (t) => {
  const a = await compose(t);
  const user = await signUp(a, "Alice");
  const add = await beginAdd(a, user);
  const proof = { flowId: add.flowId, response: await registration(add.options, await generateES256Credential()) };
  const [session] = await a.rows(coreTables.sessions);
  await a.run(a.auth.core.revokeSessions(NO_REQUEST, { sessionIds: [session._id] }));
  assert.equal((await json(await a.post("passkeys/add/finish", proof, user.tokens.accessToken), 401)).code, "not_signed_in");
  assert.equal((await a.rows(passkeyTables.passkeys)).length, 1);
});

test("a sign-in assertion cannot authorize enrollment", async (t) => {
  const a = await compose(t);
  const user = await signUp(a, "Alice");
  const started = await json(await a.post("username-passkey/sign-in/start", { username: "Alice" }));
  const proof = await assertion(started, user.credential);
  assert.equal((await json(await a.post("passkeys/add/verify", proof, user.tokens.accessToken), 400)).code, "protocol_error");
  await json(await a.post("username-passkey/sign-in/finish", proof));
});

for (const change of ["consume", "remove", "origins", "rpId", "expire"]) {
  test(`verification race: ${change} during signature verification refuses the stale session`, async (t) => {
    const a = await compose(t);
    const user = await signUp(a, "Alice");
    const started = await json(await a.post("username-passkey/sign-in/start", { username: "Alice" }));
    const proof = await assertion(started, user.credential);
    const [passkey] = await a.rows(passkeyTables.passkeys);
    const reached = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const original = crypto.subtle.verify.bind(crypto.subtle);
    const mock = t.mock.method(crypto.subtle, "verify", async (algorithm, ...rest) => {
      if (rest[0].algorithm.name === "ECDSA") {
        reached.resolve();
        await resume.promise;
      }
      return original(algorithm, ...rest);
    });
    const pending = a.post("username-passkey/sign-in/finish", proof);
    try {
      await Promise.race([reached.promise, pending.then(() => assert.fail("request finished before signature verification"))]);
      if (change === "consume") {
        mock.mock.restore();
        await json(await a.post("username-passkey/sign-in/finish", proof));
      } else if (change === "remove") {
        await a.mutate((tx) => tx.db.delete(passkeyTables.passkeys, passkey._id));
      } else if (change === "origins") {
        await a.run(a.auth.passkeySettings.set({ ...SETTINGS, origins: ["https://login.app.example.test"] }));
      } else if (change === "rpId") {
        await a.run(a.auth.passkeySettings.set({ ...SETTINGS, rpId: "example.test" }));
      } else {
        a.clock.now += CHALLENGE_TTL_MS;
      }
    } finally {
      resume.resolve();
    }
    const result = await pending;
    assert.equal(result.status, change === "remove" ? 404 : 400);
    assert.equal((await a.rows(coreTables.sessions)).length, change === "consume" ? 2 : 1);
  });
}

test("settings permissions, origin constraints and localhost availability", async (t) => {
  const a = await compose(t, {});
  assert.equal((await a.post("username-passkey/sign-in/autofill", {})).status, 404);
  assert.equal((await a.call("username-passkey/sign-in/autofill", { method: "POST", origin: "http://localhost" })).status, 200);
  const { tokens } = await json(await a.post("username-password/sign-up", { username: "Admin", password: "correct horse battery staple" }));
  const set = (body) => a.call("passkeys/settings", { method: "PUT", token: tokens.accessToken, body });
  assert.equal((await set(SETTINGS)).status, 403);
  await a.mutate((tx) => tx.db.patch(accountsTables.accounts, tokens.userId, { permissions: ["system.settings.manage"] }));
  for (const origins of [["https://unrelated.test"], ["http://app.example.test"], [`${ORIGIN}/path`], [], [`https://user@${RP_ID}`]]) {
    assert.equal((await json(await set({ ...SETTINGS, origins }), 400)).code, "invalid_passkey_settings");
  }
  assert.deepEqual(await json(await set(SETTINGS)), SETTINGS);
  assert.equal((await a.post("username-passkey/sign-in/autofill", {})).status, 200);
});

test("passkey cleanup removes at most 200 expired rows per run and preserves live rows", async (t) => {
  const a = await compose(t);
  const expiry = a.clock.now;
  for (let batch = 0; batch < 3; batch += 1) {
    await a.mutate((tx) => Effect.gen(function* () {
      for (let index = 0; index < 70; index += 1) yield* tx.db.insert(passkeyTables.challenges, {
        purpose: "register", revision: "revision", challenge: `challenge_${batch}_${index}`, expiresAt: expiry,
      });
    }));
  }
  await json(await a.post("username-passkey/sign-in/autofill", {}));
  const sweep = createExpiredPasskeyChallengesSweep(a.tenant, () => a.clock.now);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 200);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 10);
  assert.equal((await a.rows(passkeyTables.challenges)).length, 1);
});
