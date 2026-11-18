/**
 * Zelavis Auth, email + password: the method and its routes over a recording email outbox and a settable client
 * address. Cases follow upstream's `methods/email-password/server.test.ts` and the method's documented behavior; the
 * `react.test.tsx` cases are out of scope (no React hooks).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServiceRuntime } from "../dist/core/index.js";
import { setRequestClientAddress } from "../dist/core/runtime/client-address.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { emailTables } from "../dist/auth/email/tables.js";
import { passwordTables } from "../dist/auth/password/tables.js";
import { assertUserErrorsCovered } from "../dist/auth/routes/user-errors.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { emailLinkOf, openAuth, recordingOutbox, waitFor } from "./_auth.mjs";

const ORIGIN = "https://auth.example.test";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new password here";
const HOUR = 3_600_000;

async function compose(t) {
  const outbox = recordingOutbox();
  const a = await openAuth(t, { emailOutbox: outbox });
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
  const call = (path, { method = "GET", headers = {}, body } = {}) => {
    const request = new Request(`${ORIGIN}/auth/${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    setRequestClientAddress(request, client.address);
    return runtime.fetch(request);
  };
  const post = (path, body, headers) => call(path, { method: "POST", body, headers });
  const bearer = (bundle) => ({ authorization: `Bearer ${bundle.accessToken}` });
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  /** Waits for the next delivered email, and answers its link. */
  const nextLink = async (count) => {
    await waitFor(() => outbox.delivered.length >= count, { what: `email ${count}` });
    return { message: outbox.delivered[count - 1], ...emailLinkOf(outbox.delivered[count - 1]) };
  };
  /** Sign-up and verification: answers the bundle of the first session. */
  const register = async (email, password = PASSWORD) => {
    const sent = outbox.delivered.length;
    const started = await json(await post("email-password/sign-up", { email, password }), 200);
    const link = await nextLink(sent + 1);
    const done = await json(await post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: started.browserSecret }), 200);
    return done.tokens;
  };
  return { ...a, outbox, runtime, client, call, post, bearer, rows, nextLink, register };
}

const json = async (response, status) => {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${status === response.status ? "" : await response.clone().text()}`);
  return response.json();
};

test("every user error the email Schemas declare has an HTTP mapping", async () => {
  const email = await import("../dist/auth/email/validation.js");
  const { emailUnavailableUserError } = await import("../dist/auth/methods/email-password.js");
  assert.doesNotThrow(() => assertUserErrorsCovered(
    email.startFreeAddressUserError, email.completeFreeAddressUserError, email.wrongUserUserError, email.emailNotFoundUserError, emailUnavailableUserError,
  ));
});

test("sign-up: a link by email, no session yet; the link and the browser secret together verify and sign in, once", async (t) => {
  const a = await compose(t);
  const started = await a.post("email-password/sign-up", { email: "Alice@Example.test", password: PASSWORD });
  assert.equal(started.headers.getSetCookie().length, 0);
  const body = await json(started, 200);
  assert.deepEqual(Object.keys(body), ["browserSecret"]);
  const link = await a.nextLink(1);
  assert.equal(a.outbox.delivered.length, 1);
  assert.equal(link.message.to, "Alice@Example.test");
  assert.equal(link.page, "/verify-email");
  assert.equal((await a.rows(coreTables.sessions)).length, 0, "no session before the address is verified");
  assert.equal((await a.rows(emailTables.verifiedEmails)).length, 0);
  assert.equal((await a.rows(accountsTables.accounts)).length, 1);

  // The code alone, from another browser, reaches nothing; a wrong code with the right secret is refused.
  assert.equal((await json(await a.post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: "another-browser" }), 400)).code, "invalid_challenge");
  assert.equal((await json(await a.post("email-password/complete-sign-up", { emailCode: "wrong", browserSecret: body.browserSecret }), 400)).code, "incorrect_code");

  const done = await json(await a.post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: body.browserSecret }), 200);
  assert.equal(done.status, "complete");
  assert.equal((await a.rows(coreTables.sessions)).length, 1);
  assert.equal((await a.call("session", { headers: a.bearer(done.tokens) })).status, 200);
  assert.equal((await json(await a.post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: body.browserSecret }), 400)).code, "invalid_challenge");
  assert.match((await a.rows(passwordTables.passwords))[0].passwordHashPHC, /^\$pbkdf2-sha256\$i=600000\$/);
});

test("a browser page of this origin gets cookies for the verified sign-up", async (t) => {
  const a = await compose(t);
  const started = await json(await a.post("email-password/sign-up", { email: "a@example.test", password: PASSWORD }), 200);
  const link = await a.nextLink(1);
  const response = await a.post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: started.browserSecret }, { origin: ORIGIN });
  const body = await json(response, 200);
  assert.equal(body.tokens, undefined);
  assert.equal(response.headers.getSetCookie().length, 2);
});

test("sign-up refuses a bad address or password before creating anything, and a taken address after", async (t) => {
  const a = await compose(t);
  assert.equal((await json(await a.post("email-password/sign-up", { email: "nope", password: PASSWORD }), 400)).code, "invalid_email");
  assert.equal((await json(await a.post("email-password/sign-up", { email: "a@example.test", password: "short" }), 400)).code, "password_too_short");
  assert.equal((await json(await a.post("email-password/sign-up", { email: "a@example.test" }), 400)).code, "invalid_request");
  assert.equal((await a.rows(accountsTables.accounts)).length, 0);
  assert.equal(a.outbox.delivered.length, 0);
  await a.register("taken@example.test");
  assert.equal((await json(await a.post("email-password/sign-up", { email: "TAKEN@example.test", password: PASSWORD }), 409)).code, "email_taken");
  assert.equal((await a.rows(accountsTables.accounts)).length, 1, "the refused sign-up created nothing");
});

test("sign-in finds only verified addresses, in any case", async (t) => {
  const a = await compose(t);
  const started = await json(await a.post("email-password/sign-up", { email: "alice@example.test", password: PASSWORD }), 200);
  const link = await a.nextLink(1);
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: PASSWORD }), 404)).code, "user_not_found");
  await json(await a.post("email-password/complete-sign-up", { emailCode: link.code, browserSecret: started.browserSecret }), 200);
  assert.equal((await json(await a.post("email-password/sign-in", { email: "ALICE@example.test", password: PASSWORD }), 200)).status, "complete");
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: "wrong horse battery staple" }), 401)).code, "invalid_credentials");
  assert.equal((await json(await a.post("email-password/sign-in", { email: "nobody@example.test", password: PASSWORD }), 404)).code, "user_not_found");
});

test("limits: 5 starts an hour per address, 10 sign-ups per client, 60 lookups per client, none runtime-wide", async (t) => {
  const a = await compose(t);
  // Per address: the sixth sign-up attempt for one address in an hour is refused, by the address bucket
  // (each sign-up attempt of an unverified address is accepted until then).
  for (let i = 0; i < 5; i += 1) await json(await a.post("email-password/sign-up", { email: "one@example.test", password: PASSWORD }), 200);
  const limited = await a.post("email-password/sign-up", { email: "one@example.test", password: PASSWORD });
  assert.equal((await json(limited, 429)).code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await json(await a.post("email-password/recovery/start", { email: "one@example.test" }), 404)).code, "email_not_found", "an unverified address has no recovery");

  // Per client: sign-ups are admitted by the registration policy first, 10 an hour per client (part 11), so 5 more
  // addresses fill them and the 11th sign-up is refused before the email module's 20 starts per client are reached.
  for (let i = 0; i < 5; i += 1) await json(await a.post("email-password/sign-up", { email: `user${i}@example.test`, password: PASSWORD }), 200);
  assert.equal((await json(await a.post("email-password/sign-up", { email: "fresh@example.test", password: PASSWORD }), 429)).code, "registration_rate_limited");
  a.client.address = "198.51.100.8";
  await json(await a.post("email-password/sign-up", { email: "fresh@example.test", password: PASSWORD }), 200);
  // The address bucket is not per client: another client cannot send to the exhausted address either.
  assert.equal((await json(await a.post("email-password/sign-up", { email: "one@example.test", password: PASSWORD }), 429)).code, "rate_limited");

  // Lookups: 60 sign-in attempts an hour per client; a third client is unaffected.
  a.client.address = "198.51.100.9";
  for (let i = 0; i < 60; i += 1) assert.equal((await a.post("email-password/sign-in", { email: "x@example.test", password: PASSWORD })).status, 404);
  assert.equal((await json(await a.post("email-password/sign-in", { email: "x@example.test", password: PASSWORD }), 429)).code, "rate_limited");
  a.client.address = "198.51.100.10";
  assert.equal((await a.post("email-password/sign-in", { email: "x@example.test", password: PASSWORD })).status, 404);
  a.client.address = "198.51.100.9";
  a.clock.now += HOUR;
  assert.equal((await a.post("email-password/sign-in", { email: "x@example.test", password: PASSWORD })).status, 404);
});

test("change password: needs the session and the current password, ends the other sessions and tells the primary address", async (t) => {
  const a = await compose(t);
  const first = await a.register("alice@example.test");
  const second = (await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: PASSWORD }), 200)).tokens;
  const change = (headers, body) => a.post("email-password/change-password", body, headers);
  assert.equal((await json(await change({}, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }), 401)).code, "not_signed_in");
  assert.equal((await json(await change(a.bearer(first), { currentPassword: "wrong horse battery staple", newPassword: NEW_PASSWORD }), 401)).code, "invalid_credentials");
  assert.equal((await json(await change(a.bearer(first), { currentPassword: PASSWORD, newPassword: "short" }), 400)).code, "password_too_short");
  const before = a.outbox.delivered.length;
  assert.deepEqual(await json(await change(a.bearer(first), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }), 200), { success: true });
  assert.equal((await a.call("session", { headers: a.bearer(second) })).status, 401);
  assert.equal((await a.call("session", { headers: a.bearer(first) })).status, 200);
  await waitFor(() => a.outbox.delivered.length === before + 1, { what: "the notice" });
  const notice = a.outbox.delivered[before];
  assert.equal(notice.to, "alice@example.test");
  assert.equal(notice.subject, "Your password was changed");
  assert.doesNotMatch(notice.text, /#code=|http/, "a notice carries no link");
  a.clock.now += 61_000;
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: NEW_PASSWORD }), 200)).status, "complete");
});

test("change email: needs the password; completion moves the primary address and tells the old one", async (t) => {
  const a = await compose(t);
  const bundle = await a.register("old@example.test");
  const start = (headers, body) => a.post("email-password/change-email/start", body, headers);
  assert.equal((await json(await start({}, { newEmail: "new@example.test", password: PASSWORD }), 401)).code, "not_signed_in");
  assert.equal((await json(await start(a.bearer(bundle), { newEmail: "new@example.test", password: "wrong horse battery staple" }), 401)).code, "invalid_credentials");
  assert.equal((await json(await start(a.bearer(bundle), { newEmail: "bad", password: PASSWORD }), 400)).code, "invalid_email");
  assert.equal(a.outbox.delivered.length, 1, "nothing was sent for the refused starts");

  const started = await json(await start(a.bearer(bundle), { newEmail: "new@example.test", password: PASSWORD }), 200);
  const link = await a.nextLink(2);
  assert.equal(link.message.to, "new@example.test");
  assert.equal(link.page, "/change-email");
  const complete = (headers, body) => a.post("email-password/change-email/complete", body, headers);
  assert.equal((await json(await complete({}, { emailCode: link.code, browserSecret: started.browserSecret }), 401)).code, "not_signed_in");
  // Another signed-in account cannot complete it, and the link stays.
  const other = await a.register("other@example.test");
  assert.equal((await json(await complete(a.bearer(other), { emailCode: link.code, browserSecret: started.browserSecret }), 403)).code, "wrong_user");
  assert.deepEqual(await json(await complete(a.bearer(bundle), { emailCode: link.code, browserSecret: started.browserSecret }), 200), { success: true });
  await waitFor(() => a.outbox.delivered.some((message) => message.subject === "Your email address was changed"), { what: "the notice to the old address" });
  assert.equal(a.outbox.delivered.find((message) => message.subject === "Your email address was changed").to, "old@example.test");

  a.clock.now += 61_000;
  assert.equal((await json(await a.post("email-password/sign-in", { email: "old@example.test", password: PASSWORD }), 404)).code, "user_not_found");
  assert.equal((await json(await a.post("email-password/sign-in", { email: "new@example.test", password: PASSWORD }), 200)).status, "complete");
  assert.deepEqual((await json(await a.call("emails", { headers: a.bearer(bundle) }), 200)).emails, [{ email: "new@example.test", isPrimary: true }]);
});

test("recovery: a link to a verified address, checked without being used up, then a new password that ends every session", async (t) => {
  const a = await compose(t);
  const bundle = await a.register("Alice@Example.test");
  const sent = a.outbox.delivered.length;
  assert.equal((await json(await a.post("email-password/recovery/start", { email: "nobody@example.test" }), 404)).code, "email_not_found");
  const started = await json(await a.post("email-password/recovery/start", { email: "alice@example.test" }), 200);
  const link = await a.nextLink(sent + 1);
  assert.equal(link.message.to, "Alice@Example.test", "the link goes to the address as it was verified");
  assert.equal(link.message.kind, "password-recovery");
  assert.equal(link.page, "/reset-password");
  assert.match(link.message.text, /10 minutes/);

  const check = (body) => a.post("email-password/recovery/check", body);
  assert.deepEqual(await json(await check({ emailCode: link.code, browserSecret: started.browserSecret }), 200), { valid: true });
  assert.deepEqual(await json(await check({ emailCode: link.code, browserSecret: started.browserSecret }), 200), { valid: true }, "check does not consume");
  assert.deepEqual(await json(await check({ emailCode: "wrong", browserSecret: started.browserSecret }), 200), { valid: false });

  const complete = (body) => a.post("email-password/recovery/complete", body);
  assert.equal((await json(await complete({ emailCode: link.code, browserSecret: started.browserSecret, newPassword: "short" }), 400)).code, "password_too_short");
  assert.deepEqual(await json(await check({ emailCode: link.code, browserSecret: started.browserSecret }), 200), { valid: true }, "a refused password did not burn the link");
  const claim = { emailCode: link.code, browserSecret: started.browserSecret, newPassword: NEW_PASSWORD };
  const raced = await Promise.all([complete(claim), complete(claim)]);
  assert.deepEqual(raced.map(({ status }) => status).sort(), [200, 400]);
  const done = await json(raced.find(({ status }) => status === 200), 200);
  assert.equal(done.status, "complete");
  assert.equal((await a.call("session", { headers: a.bearer(bundle) })).status, 401, "the account's other sessions were refused");
  assert.equal((await a.call("session", { headers: a.bearer(done.tokens) })).status, 200, "the recovery's own session works");
  assert.equal((await json(await complete({ emailCode: link.code, browserSecret: started.browserSecret, newPassword: NEW_PASSWORD }), 400)).code, "invalid_challenge");
  await waitFor(() => a.outbox.delivered.some((message) => message.subject === "Your password was changed"), { what: "the notice" });
  a.clock.now += 61_000;
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: PASSWORD }), 401)).code, "invalid_credentials");
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: NEW_PASSWORD }), 200)).status, "complete");
});

test("recovery: an invalid link spends the client quota without running the password hash", async (t) => {
  const a = await compose(t);
  const derive = t.mock.method(crypto.subtle, "deriveBits");
  const claim = { emailCode: "unknown", browserSecret: "unknown", newPassword: NEW_PASSWORD };
  const complete = () => a.post("email-password/recovery/complete", claim);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await json(await complete(), 400)).code, "invalid_challenge");
  }
  const limited = await complete();
  assert.equal((await json(limited, 429)).code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "180");
  a.client.address = "198.51.100.8";
  assert.equal((await json(await complete(), 400)).code, "invalid_challenge");
  assert.equal(derive.mock.callCount(), 0);
});

test("a recovery link lives ten minutes", async (t) => {
  const a = await compose(t);
  await a.register("alice@example.test");
  const sent = a.outbox.delivered.length;
  const started = await json(await a.post("email-password/recovery/start", { email: "alice@example.test" }), 200);
  const link = await a.nextLink(sent + 1);
  a.clock.now += 10 * 60_000;
  assert.deepEqual(await json(await a.post("email-password/recovery/check", { emailCode: link.code, browserSecret: started.browserSecret }), 200), { valid: false });
});

test("an outstanding recovery link cannot reset a different account after an address is reassigned", async (t) => {
  const a = await compose(t);
  const first = await a.register("alice@example.test");
  const second = await a.register("bob@example.test");
  const started = await json(await a.post("email-password/recovery/start", { email: "alice@example.test" }), 200);
  const { code } = await a.nextLink(3);
  const addresses = await a.rows(emailTables.verifiedEmails);
  const original = addresses.find(({ userId }) => userId === first.userId);
  await a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) =>
    tx.db.patch(emailTables.verifiedEmails, original._id, { userId: second.userId, isPrimary: false })));
  const claim = { emailCode: code, browserSecret: started.browserSecret };
  assert.deepEqual(await json(await a.post("email-password/recovery/check", claim), 200), { valid: false });
  const reset = await a.post("email-password/recovery/complete", { ...claim, newPassword: NEW_PASSWORD });
  assert.equal((await json(reset, 400)).code, "invalid_challenge");
  assert.equal((await a.call("session", { headers: a.bearer(second) })).status, 200);
});

test("add email: a username-style account with no address can add one; it becomes primary", async (t) => {
  const a = await compose(t);
  // An account made by the username + password method has no address.
  const bundle = (await json(await a.post("username-password/sign-up", { username: "owner", password: PASSWORD }), 200)).tokens;
  assert.deepEqual((await json(await a.call("emails", { headers: a.bearer(bundle) }), 200)).emails, []);
  assert.equal((await json(await a.post("emails/add/start", { email: "owner@example.test" }), 401)).code, "not_signed_in");
  const started = await json(await a.post("emails/add/start", { email: "owner@example.test" }, a.bearer(bundle)), 200);
  const link = await a.nextLink(1);
  assert.equal(link.page, "/verify-email");
  assert.deepEqual(await json(await a.post("emails/add/complete", { emailCode: link.code, browserSecret: started.browserSecret }, a.bearer(bundle)), 200), { success: true });
  assert.deepEqual((await json(await a.call("emails", { headers: a.bearer(bundle) }), 200)).emails, [{ email: "owner@example.test", isPrimary: true }]);
  assert.equal((await json(await a.post("emails/add/start", { email: "OWNER@example.test" }, a.bearer(bundle)), 409)).code, "email_taken");
});

test("with email delivery unavailable every start answers 409 email_unavailable and writes nothing", async (t) => {
  const a = await compose(t);
  const bundle = await a.register("alice@example.test");
  a.outbox.linkBaseUrl = undefined;
  const before = { accounts: (await a.rows(accountsTables.accounts)).length, challenges: (await a.rows(emailTables.challenges)).length, delivered: a.outbox.delivered.length };
  const starts = [
    ["email-password/sign-up", { email: "new@example.test", password: PASSWORD }, {}],
    ["email-password/recovery/start", { email: "alice@example.test" }, {}],
    ["email-password/change-email/start", { newEmail: "new@example.test", password: PASSWORD }, a.bearer(bundle)],
    ["emails/add/start", { email: "new@example.test" }, a.bearer(bundle)],
  ];
  for (const [path, body, headers] of starts) assert.equal((await json(await a.post(path, body, headers), 409)).code, "email_unavailable", path);
  assert.deepEqual({ accounts: (await a.rows(accountsTables.accounts)).length, challenges: (await a.rows(emailTables.challenges)).length, delivered: a.outbox.delivered.length }, before);
  // What needs no mail still works: signing in with the verified address.
  a.clock.now += 61_000;
  assert.equal((await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: PASSWORD }), 200)).status, "complete");
});

