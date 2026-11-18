/**
 * Zelavis Auth, the email module: verified emails, the challenge kinds (signUp, changeEmail, addEmail, custom), the
 * rate limits and the expired-challenge sweep.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { addEmail, changeEmail, custom, signUp } from "../dist/auth/email/challenge/index.js";
import { createExpiredChallengesSweep } from "../dist/auth/email/cleanup.js";
import { emailTables } from "../dist/auth/email/tables.js";
import { normalizeEmail } from "../dist/auth/email/validation.js";
import { deleteUser, getEmails, getPrimaryEmail, lookupEmail } from "../dist/auth/email/verifiedEmails.js";
import { buildLink } from "../dist/auth/email/templates.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { createLimiterBucketsSweep, limiterTables } from "../dist/auth/runtime/index.js";
import { emailLinkOf, openAuth, recordingOutbox, waitFor } from "./_auth.mjs";

const SENDER = { linkBase: new URL("https://example.test/app"), runtimeName: "Test Runtime" };
const IP = "198.51.100.7";
const HOUR = 3_600_000;

async function open(t, options = {}) {
  const outbox = recordingOutbox();
  const a = await openAuth(t, { emailOutbox: outbox, ...options });
  const running = await a.run(a.auth.start());
  t.after(() => a.run(running.stop()));
  const mutate = (body, ip = IP) => a.run(a.core.mutation({ ip }, body));
  const read = (body) => a.run(a.core.query({ ip: IP }, body));
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  /** Starts a challenge of `kind` and waits for its email; answers the start result and the emailed code. */
  const begin = async (kind, args, ip = IP) => {
    const before = outbox.delivered.length;
    const result = await mutate((tx) => kind(tx, { emailSender: SENDER, ...args }), ip);
    if (!result.success) return { result };
    await waitFor(() => outbox.delivered.length === before + 1, { what: "the challenge email" });
    return { result, message: outbox.delivered[before], ...emailLinkOf(outbox.delivered[before]) };
  };
  return { ...a, outbox, mutate, read, rows, begin };
}

/** A user with a verified address, through the signUp challenge. */
async function verified(a, userId, email) {
  const { result, code } = await a.begin(signUp._internal_dangerous_start, { userId, email });
  assert.equal(result.success, true);
  const done = await a.mutate((tx) => signUp.complete(tx, { emailCode: code, browserSecret: result.browserSecret }));
  assert.deepEqual(done, { success: true, userId, email });
}

// --- the link ----------------------------------------------------------------------------------------------------

test("a link opens a page under the link base's directory and carries its code in the fragment only", () => {
  const link = new URL(buildLink(new URL("https://example.test/app"), "verify-email", "abc_-123"));
  assert.equal(link.origin + link.pathname, "https://example.test/app/verify-email");
  assert.equal(link.search, "");
  assert.equal(link.hash, "#code=abc_-123");
});

// --- signUp ------------------------------------------------------------------------------------------------------

test("signUp: the start queues one email naming the runtime and the expiry; completion records the primary address once", async (t) => {
  const a = await open(t);
  const { result, message, page, code } = await a.begin(signUp._internal_dangerous_start, { userId: "user1", email: "Alice@Example.test" });
  assert.equal(result.success, true);
  assert.equal(page, "/app/verify-email");
  assert.equal(message.to, "Alice@Example.test");
  assert.equal(message.kind, "email-verification");
  assert.match(message.text, /1 hour/);
  assert.match(message.text, /Test Runtime/);
  assert.deepEqual(await a.rows(emailTables.verifiedEmails), [], "nothing is verified before the link is opened");
  const done = await a.mutate((tx) => signUp.complete(tx, { emailCode: code, browserSecret: result.browserSecret }));
  assert.deepEqual(done, { success: true, userId: "user1", email: "Alice@Example.test" });
  const [row] = await a.rows(emailTables.verifiedEmails);
  assert.deepEqual([row.email, row.normalizedEmail, row.userId, row.isPrimary], ["Alice@Example.test", "alice@example.test", "user1", true]);
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: code, browserSecret: result.browserSecret })), { success: false, userError: { error: "INVALID_CHALLENGE" } }, "a link works once");
  assert.equal((await a.rows(emailTables.challenges)).length, 0);
});

test("signUp: raw codes and secrets are never stored, only their hashes", async (t) => {
  const a = await open(t);
  const { result, code } = await a.begin(signUp._internal_dangerous_start, { userId: "user1", email: "a@example.test" });
  const stored = JSON.stringify(await a.rows(emailTables.challenges));
  assert.ok(!stored.includes(code) && !stored.includes(result.browserSecret));
});

test("a wrong code keeps the challenge; the browser that did not start it cannot reach it at all", async (t) => {
  const a = await open(t);
  const { result, code } = await a.begin(signUp._internal_dangerous_start, { userId: "user1", email: "a@example.test" });
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: "not-the-code", browserSecret: result.browserSecret })), { success: false, userError: { error: "INCORRECT_CODE" } });
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: code, browserSecret: "another-browser" })), { success: false, userError: { error: "INVALID_CHALLENGE" } });
  assert.equal((await a.rows(emailTables.challenges)).length, 1, "neither failure burned the challenge");
  assert.equal((await a.mutate((tx) => signUp.complete(tx, { emailCode: code, browserSecret: result.browserSecret }))).success, true);
});

test("a challenge is expired at exactly its expiresAt, and live a moment before", async (t) => {
  const a = await open(t);
  const first = await a.begin(signUp._internal_dangerous_start, { userId: "user1", email: "a@example.test" });
  const second = await a.begin(signUp._internal_dangerous_start, { userId: "user2", email: "b@example.test" });
  const startedAt = a.clock.now;
  a.clock.now = startedAt + HOUR - 1;
  assert.equal((await a.mutate((tx) => signUp.complete(tx, { emailCode: first.code, browserSecret: first.result.browserSecret }))).success, true);
  a.clock.now = startedAt + HOUR;
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: second.code, browserSecret: second.result.browserSecret })), { success: false, userError: { error: "INVALID_CHALLENGE" } });
});

test("signUp: the start refuses a taken address; the completion refuses one taken since; a user with an address gets an invalid challenge", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "taken@example.test");
  assert.deepEqual((await a.begin(signUp._internal_dangerous_start, { userId: "user2", email: "TAKEN@example.test" })).result, { success: false, userError: { error: "EMAIL_TAKEN" } });

  // Two sign-ups for one address, started while it was free: the first to complete wins.
  const one = await a.begin(signUp._internal_dangerous_start, { userId: "user3", email: "race@example.test" });
  const two = await a.begin(signUp._internal_dangerous_start, { userId: "user4", email: "race@example.test" });
  assert.equal((await a.mutate((tx) => signUp.complete(tx, { emailCode: one.code, browserSecret: one.result.browserSecret }))).success, true);
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: two.code, browserSecret: two.result.browserSecret })), { success: false, userError: { error: "EMAIL_TAKEN" } });

  // Two challenges for one user: once one completed, the other link is dead.
  const x = await a.begin(signUp._internal_dangerous_start, { userId: "user5", email: "x@example.test" });
  const y = await a.begin(signUp._internal_dangerous_start, { userId: "user5", email: "y@example.test" });
  assert.equal((await a.mutate((tx) => signUp.complete(tx, { emailCode: x.code, browserSecret: x.result.browserSecret }))).success, true);
  assert.deepEqual(await a.mutate((tx) => signUp.complete(tx, { emailCode: y.code, browserSecret: y.result.browserSecret })), { success: false, userError: { error: "INVALID_CHALLENGE" } });
});

test("signUp: starting for a user that already has an address is a defect and writes nothing", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "a@example.test");
  const before = (await a.rows(emailTables.challenges)).length;
  await assert.rejects(() => a.mutate((tx) => signUp._internal_dangerous_start(tx, { userId: "user1", email: "b@example.test", emailSender: SENDER })));
  assert.equal((await a.rows(emailTables.challenges)).length, before);
});

test("a malformed address is INVALID_EMAIL and takes no token", async (t) => {
  const a = await open(t);
  for (const email of ["", "no-at", "a@b", "a@[127.0.0.1]", "a b@example.test", "a@exa mple.test", `${"x".repeat(250)}@example.test`, "é@example.test"]) {
    assert.deepEqual(await a.mutate((tx) => signUp.check(tx, { email })), { error: "INVALID_EMAIL" }, email);
  }
  assert.equal((await a.rows(emailTables.challenges)).length, 0);
});

// --- addEmail and changeEmail ------------------------------------------------------------------------------------

test("addEmail: the first address is primary, a later one secondary; another user's completion is WRONG_USER and keeps the link", async (t) => {
  const a = await open(t);
  const first = await a.begin(addEmail._internal_dangerous_start, { userId: "user1", email: "one@example.test" });
  assert.deepEqual(await a.mutate((tx) => addEmail.complete(tx, { emailCode: first.code, browserSecret: first.result.browserSecret, userId: "user2" })), { success: false, userError: { error: "WRONG_USER" } });
  assert.deepEqual(await a.mutate((tx) => addEmail.complete(tx, { emailCode: first.code, browserSecret: first.result.browserSecret, userId: "user1" })), { success: true, userId: "user1", email: "one@example.test" });
  const second = await a.begin(addEmail._internal_dangerous_start, { userId: "user1", email: "two@example.test" });
  await a.mutate((tx) => addEmail.complete(tx, { emailCode: second.code, browserSecret: second.result.browserSecret, userId: "user1" }));
  assert.deepEqual(await a.read((tx) => getEmails(tx, { userId: "user1" })), [{ email: "one@example.test", isPrimary: true }, { email: "two@example.test", isPrimary: false }]);
  assert.equal(await a.read((tx) => getPrimaryEmail(tx, { userId: "user1" })), "one@example.test");
});

test("changeEmail: the new address replaces the primary one and the old address is free again", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "old@example.test");
  const change = await a.begin(changeEmail._internal_dangerous_start, { userId: "user1", email: "new@example.test" });
  assert.equal(change.page, "/app/change-email");
  assert.deepEqual(await a.mutate((tx) => changeEmail.complete(tx, { emailCode: change.code, browserSecret: change.result.browserSecret, userId: "user2" })), { success: false, userError: { error: "WRONG_USER" } });
  assert.deepEqual(await a.mutate((tx) => changeEmail.complete(tx, { emailCode: change.code, browserSecret: change.result.browserSecret, userId: "user1" })), { success: true, userId: "user1", email: "new@example.test", previousEmail: "old@example.test" });
  assert.deepEqual(await a.read((tx) => getEmails(tx, { userId: "user1" })), [{ email: "new@example.test", isPrimary: true }]);
  assert.deepEqual(await a.mutate((tx) => lookupEmail(tx, { email: "old@example.test" })), { success: false, userError: { error: "EMAIL_NOT_FOUND" } });
  // The released address can be verified by another user.
  await verified(a, "user2", "old@example.test");
});

// --- custom ------------------------------------------------------------------------------------------------------

const COPY = { kind: "password-recovery", page: "reset-password", subject: "Subject", intro: "Intro:" };
const customStart = (args) => (tx, extra) => custom.start(tx, { copy: COPY, purpose: "test/purpose", expectedUserId: null, ...args, ...extra });

test("custom: peek does not consume the link, complete does, and a purpose other than the started one is a defect", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "a@example.test");
  const started = await a.begin(customStart({ email: "a@example.test" }), {});
  assert.equal(started.message.kind, "password-recovery");
  assert.equal(started.page, "/app/reset-password");
  const args = { emailCode: started.code, browserSecret: started.result.browserSecret, purpose: "test/purpose", currentUserId: null };
  const expected = { success: true, email: "a@example.test", emailOwnerId: "user1" };
  assert.deepEqual(await a.read((tx) => custom.peek(tx, args)), expected);
  assert.deepEqual(await a.read((tx) => custom.peek(tx, args)), expected, "peek twice");
  await assert.rejects(() => a.mutate((tx) => custom.complete(tx, { ...args, purpose: "other/purpose" })));
  assert.equal((await a.rows(emailTables.challenges)).length, 1, "the defect rolled back");
  assert.deepEqual(await a.mutate((tx) => custom.complete(tx, args)), expected);
  assert.deepEqual(await a.read((tx) => custom.peek(tx, args)), { success: false, userError: { error: "INVALID_CHALLENGE" } });
});

test("custom: with an expected user, another caller is WRONG_USER and keeps the link; an address that moved is an invalid challenge", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "a@example.test");
  const started = await a.begin(customStart({ email: "a@example.test", expectedUserId: "user1" }), {});
  const args = { emailCode: started.code, browserSecret: started.result.browserSecret, purpose: "test/purpose" };
  assert.deepEqual(await a.mutate((tx) => custom.complete(tx, { ...args, currentUserId: "user2" })), { success: false, userError: { error: "WRONG_USER" } });
  assert.deepEqual(await a.mutate((tx) => custom.complete(tx, { ...args, currentUserId: null })), { success: false, userError: { error: "WRONG_USER" } });

  await a.mutate((tx) => deleteUser(tx, { userId: "user1" }));
  await verified(a, "user2", "a@example.test");
  assert.deepEqual(await a.mutate((tx) => custom.complete(tx, { ...args, currentUserId: "user1" })), { success: false, userError: { error: "INVALID_CHALLENGE" } });
});

test("custom: a ttl outside one minute to 24 hours is a defect", async (t) => {
  const a = await open(t);
  for (const ttlMs of [59_999, 86_400_001, Number.NaN]) {
    await assert.rejects(() => a.mutate((tx) => custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email: "a@example.test", emailSender: SENDER, ttlMs })), String(ttlMs));
  }
  assert.equal((await a.begin(customStart({ email: "a@example.test", ttlMs: 60_000 }), {})).result.success, true);
});

// --- verified emails ---------------------------------------------------------------------------------------------

test("lookupEmail ignores case and answers the stored spelling; normalization lowercases, then composes", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "Jane.Doe@Example.test");
  assert.deepEqual(await a.mutate((tx) => lookupEmail(tx, { email: "JANE.doe@EXAMPLE.TEST" })), { success: true, userId: "user1", storedEmail: "Jane.Doe@Example.test" });
  assert.deepEqual(await a.mutate((tx) => lookupEmail(tx, { email: "nobody@example.test" })), { success: false, userError: { error: "EMAIL_NOT_FOUND" } });
  // Addresses must be printable ASCII to be stored, but the normalization is what a comparison relies on.
  assert.equal(normalizeEmail("E\u0301@Example.test"), "\u00e9@example.test");
  assert.equal(normalizeEmail("\u0130@x.test"), "i\u0307@x.test");
});

test("deleteUser removes the user's addresses and pending challenges, and is idempotent", async (t) => {
  const a = await open(t);
  await verified(a, "user1", "a@example.test");
  await a.begin(addEmail._internal_dangerous_start, { userId: "user1", email: "b@example.test" });
  await a.begin(addEmail._internal_dangerous_start, { userId: "user2", email: "c@example.test" });
  await a.mutate((tx) => deleteUser(tx, { userId: "user1" }));
  await a.mutate((tx) => deleteUser(tx, { userId: "user1" }));
  assert.deepEqual(await a.rows(emailTables.verifiedEmails), []);
  const left = await a.rows(emailTables.challenges);
  assert.equal(left.length, 1);
  assert.equal(left[0].purpose.userId, "user2");
});

// --- rate limits -------------------------------------------------------------------------------------------------

test("the lookup limit is 60 an hour per client address; another client and a later hour are unaffected", async (t) => {
  const a = await open(t);
  const look = (ip) => a.mutate((tx) => lookupEmail(tx, { email: "x@example.test" }), ip);
  for (let i = 0; i < 60; i += 1) assert.equal((await look(IP)).userError.error, "EMAIL_NOT_FOUND");
  const limited = await look(IP);
  assert.equal(limited.userError.error, "RATE_LIMITED");
  assert.ok(limited.userError.retryAfterMs > 0 && limited.userError.retryAfterMs <= 60_000);
  assert.equal((await look("198.51.100.8")).userError.error, "EMAIL_NOT_FOUND", "no runtime-wide bucket");
  a.clock.now += HOUR;
  assert.equal((await look(IP)).userError.error, "EMAIL_NOT_FOUND");
});

test("starts are limited to 5 an hour per address and 20 an hour per client, each only for its own key", async (t) => {
  const a = await open(t);
  const start = (email, ip = IP) => a.mutate((tx) => custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email, emailSender: SENDER }), ip);
  for (let i = 0; i < 5; i += 1) assert.equal((await start("one@example.test")).success, true);
  assert.equal((await start("ONE@example.test")).userError.error, "RATE_LIMITED", "the sixth for one address, in any case");
  assert.equal((await start("one@example.test", "198.51.100.8")).userError.error, "RATE_LIMITED", "the address limit holds for every client");
  // 5 are spent on `one@`; 15 more addresses from this client fill its 20.
  for (let i = 0; i < 15; i += 1) assert.equal((await start(`user${i}@example.test`)).success, true);
  assert.equal((await start("another@example.test")).userError.error, "RATE_LIMITED", "the 21st from one client");
  assert.equal((await start("another@example.test", "198.51.100.8")).success, true, "another client is unaffected");
  // A refused start took nothing from the other bucket: the address that was refused above still has its tokens.
  assert.equal((await start("fresh@example.test", "198.51.100.9")).success, true);
});

test("a runtime without a client address shares one key instead of failing", async (t) => {
  const a = await open(t);
  const start = (email) => a.run(a.core.mutation({ ip: null }, (tx) => custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email, emailSender: SENDER })));
  for (let i = 0; i < 20; i += 1) assert.equal((await start(`user${i}@example.test`)).success, true);
  assert.equal((await start("over@example.test")).userError.error, "RATE_LIMITED");
});

test("the check of a start reads the limits without taking a token", async (t) => {
  const a = await open(t);
  for (let i = 0; i < 30; i += 1) assert.equal(await a.mutate((tx) => custom.check(tx, { email: "a@example.test" })), null);
  assert.equal((await a.begin(customStart({ email: "a@example.test" }), {})).result.success, true);
});

// --- delivery ----------------------------------------------------------------------------------------------------

test("concurrent starts from one client conflict on its bucket, retry, and deliver exactly one message each", async (t) => {
  const a = await open(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => a.mutate((tx) => custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email: `user${i}@example.test`, emailSender: SENDER }))));
  assert.ok(results.every((result) => result.success));
  await waitFor(() => a.outbox.delivered.length >= 4, { what: "four emails" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(a.outbox.delivered.length, 4);
  assert.deepEqual(new Set(a.outbox.delivered.map((message) => message.id)), new Set(results.map((result) => `auth-${result.challengeId}`)));
});

test("a failed transaction after a start sends nothing and keeps nothing", async (t) => {
  const a = await open(t);
  await assert.rejects(() => a.mutate((tx) => Effect.flatMap(
    custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email: "a@example.test", emailSender: SENDER }),
    () => Effect.die(new Error("rolled back")),
  )));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(a.outbox.delivered, []);
  assert.deepEqual(await a.rows(emailTables.challenges), []);
});

// --- the sweep ---------------------------------------------------------------------------------------------------

const insertChallenge = (a, expiresAt, tag) => a.run(a.auth.runtime.mutation(NO_REQUEST, (tx) =>
  tx.db.insert(emailTables.challenges, { email: `${tag}@example.test`, purpose: { kind: "custom", purpose: "p" }, emailCodeHash: tag, browserSecretHash: tag, expiresAt })));

test("the sweep removes expired challenges 200 a run, never a live one", async (t) => {
  const a = await open(t);
  const sweep = createExpiredChallengesSweep(a.tenant, () => a.clock.now);
  const base = a.clock.now;
  for (let i = 0; i < 450; i += 1) await insertChallenge(a, base - 1000 + (i % 7), `old${i}`);
  await insertChallenge(a, base + 60_000, "live");
  await insertChallenge(a, base, "boundary"); // expired at exactly expiresAt
  const run = () => a.run(sweep.run(a.auth.runtime));
  assert.deepEqual([await run(), await run(), await run(), await run()], [200, 200, 51, 0]);
  const left = await a.rows(emailTables.challenges);
  assert.deepEqual(left.map((row) => row.email), ["live@example.test"]);
});

test("the sweep skips a row it cannot decode with a warning naming its collection and id, and carries on", async (t) => {
  const a = await open(t);
  const sweep = createExpiredChallengesSweep(a.tenant, () => a.clock.now);
  const base = a.clock.now;
  await insertChallenge(a, base - 10, "good1");
  await a.run(a.tenant.documents.insert({ collection: emailTables.challenges.collection, id: "bad", data: { _id: "bad", _creationTime: base, expiresAt: base - 20, email: 7 } }));
  await insertChallenge(a, base - 5, "good2");
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 2);
  const left = await a.run(a.tenant.documents.findMany({ collection: emailTables.challenges.collection }));
  assert.deepEqual(left.map((document) => document.id), ["bad"]);
  const warning = a.logs.find((entry) => entry.text.includes("email.expiredChallenges"));
  assert.ok(warning, "a warning was logged");
  assert.match(warning.text, /email_challenges row bad/);
  assert.ok(!warning.text.includes("7"), "no row content in the warning");
});

test("the bucket sweep removes a bucket idle for a full refill, keeps a recent one, and a removed bucket reads as full", async (t) => {
  const a = await open(t);
  const sweep = createLimiterBucketsSweep(a.tenant, () => a.clock.now);
  const start = (email) => a.mutate((tx) => custom.start(tx, { copy: COPY, purpose: "p", expectedUserId: null, email, emailSender: SENDER }));
  for (let i = 0; i < 5; i += 1) await start("drained@example.test"); // the address bucket is empty now
  assert.equal((await start("drained@example.test")).userError.error, "RATE_LIMITED");
  const buckets = async () => (await a.rows(limiterTables.buckets)).length;
  const before = await buckets();
  assert.ok(before >= 2);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 0, "nothing is idle yet");
  a.clock.now += HOUR - 1;
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 0, "not yet a full refill");
  a.clock.now += 2;
  assert.equal(await a.run(sweep.run(a.auth.runtime)), before);
  assert.equal(await buckets(), 0);
  for (let i = 0; i < 5; i += 1) assert.equal((await start("drained@example.test")).success, true, "the next limit allows the full capacity");
});
