/**
 * Zelavis Auth, username + password: the username module, the password module and its validation, the method and its
 * routes. Cases are ported from upstream's `components/username/username.test.ts`,
 * `components/password/{passwordProvider,validation,commonPasswords}.test.ts` and the method's behavior, over
 * `test/_auth.mjs`.
 *
 * Not ported (they test what Zelavis does not have): the hash-wasm interoperability and argon2i/argon2d leniency
 * cases (Zelavis hashes with PBKDF2, covered in auth-password-hashing.test.mjs), the `minimumLength` argument of
 * `_internal_dangerous_setPassword` (the method validates before it hashes), and `react.test.tsx`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { createServiceRuntime } from "../dist/core/index.js";
import { coreTables } from "../dist/auth/core/tables.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { DEFAULT_MIN_PASSWORD_LENGTH } from "../dist/auth/lib/password.js";
import { hashPassword, verifyPasswordHash } from "../dist/auth/password/hashing.js";
import { COMMON_PASSWORDS_BY_LENGTH } from "../dist/auth/password/commonPasswords.generated.js";
import { isCommonPassword } from "../dist/auth/password/commonPasswords.js";
import { _internal_dangerous_setPassword, beginVerify, finishVerify } from "../dist/auth/password/public.js";
import { passwordTables } from "../dist/auth/password/tables.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
  validatePasswordInputFormat,
} from "../dist/auth/password/validation.js";
import { setupUsernamePassword } from "../dist/auth/methods/username-password.js";
import { assertUserErrorsCovered } from "../dist/auth/routes/user-errors.js";
import { deleteUsername, getUserIdByUsername, getUsername, setUsername } from "../dist/auth/username/public.js";
import { usernameTables } from "../dist/auth/username/tables.js";
import { MAX_USERNAME_LENGTH } from "../dist/auth/username/validation.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { openAuth } from "./_auth.mjs";

const CALL = { ip: null };
const PASSWORD = "correct horse battery staple"; // 28 chars, valid
const ORIGIN = "https://auth.example.test";
// Generated with `htpasswd -bnBC 5 "" "legacy password 123"`.
const BCRYPT_LEGACY = "$2y$05$Jq7vbW98iEIeWS4eusJ0yOWRfj1ZOS/50q1cQEZLtdZGpNI/Q/0W2";
const LEGACY_PASSWORD = "legacy password 123";

const rows = (a, table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
const mutate = (a, body) => a.run(a.core.mutation(CALL, body));
const read = (a, body) => a.run(a.core.query(CALL, body));

const setName = (a, userId, username) => mutate(a, (tx) => setUsername(tx, { userId, username }));
const idOf = (a, username) => read(a, (tx) => getUserIdByUsername(tx, { username }));
const nameOf = (a, userId) => read(a, (tx) => getUsername(tx, { userId }));

async function setPassword(a, userId, password) {
  const passwordHashPHC = await a.run(hashPassword(password));
  await mutate(a, (tx) => _internal_dangerous_setPassword(tx, { userId, passwordHashPHC }));
}

/** Verification as the method runs it: begin, check the hash outside any transaction, finish. */
async function verify(a, userId, password) {
  const begun = await mutate(a, (tx) => beginVerify(tx, { userId, password }));
  if (!begun.success) return begun;
  if (!(await a.run(verifyPasswordHash(password, begun.stored)))) return { success: false, userError: { error: "INVALID_CREDENTIALS" } };
  return mutate(a, (tx) => finishVerify(tx, { userId, stored: begun.stored }));
}

// --- username module (upstream components/username/username.test.ts) ------------------------------------------

test("setUsername sets a username for a user with no username", async (t) => {
  const a = await openAuth(t);
  assert.deepEqual(await setName(a, "user1", "Alice"), { success: true, previousUsername: null });
  assert.equal(await nameOf(a, "user1"), "Alice");
});

test("setUsername renames a user and returns the previous username; the old one is free", async (t) => {
  const a = await openAuth(t);
  await setName(a, "user1", "Alice");
  assert.deepEqual(await setName(a, "user1", "Bob"), { success: true, previousUsername: "Alice" });
  assert.equal((await rows(a, usernameTables.usernames)).length, 1);
  assert.equal(await idOf(a, "alice"), null);
  assert.equal(await idOf(a, "bob"), "user1");
});

test("setUsername keeps the new spelling when the same user sets the same username", async (t) => {
  const a = await openAuth(t);
  await setName(a, "user1", "alice");
  assert.deepEqual(await setName(a, "user1", "ALICE"), { success: true, previousUsername: "alice" });
  assert.equal(await nameOf(a, "user1"), "ALICE");
});

test("setUsername rejects a username another user has, in any case, and changes nothing", async (t) => {
  const a = await openAuth(t);
  await setName(a, "user1", "Alice");
  for (const username of ["Alice", "ALICE", "alice"]) {
    assert.deepEqual(await setName(a, "user2", username), { success: false, userError: { error: "USERNAME_TAKEN" } });
  }
  assert.equal(await nameOf(a, "user2"), null);
});

test("setUsername rejects an empty username", async (t) => {
  const a = await openAuth(t);
  assert.deepEqual(await setName(a, "user1", ""), { success: false, userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 } });
});

test("setUsername accepts one character and the maximum length, counting code points", async (t) => {
  const a = await openAuth(t);
  assert.deepEqual(await setName(a, "user1", "a"), { success: true, previousUsername: null });
  const long = "😀".repeat(MAX_USERNAME_LENGTH);
  assert.deepEqual(await setName(a, "user2", long), { success: true, previousUsername: null });
  assert.equal(await idOf(a, long), "user2");
});

test("setUsername rejects a username that is too long, and a lookup of one finds nothing", async (t) => {
  const a = await openAuth(t);
  for (const username of ["b".repeat(MAX_USERNAME_LENGTH + 1), "b".repeat(1_000_000)]) {
    assert.deepEqual(await setName(a, "user1", username), { success: false, userError: { error: "USERNAME_TOO_LONG", maximumLength: MAX_USERNAME_LENGTH } });
    assert.equal(await idOf(a, username), null);
  }
});

test("setUsername rejects surrounding whitespace, and a username of only whitespace", async (t) => {
  const a = await openAuth(t);
  for (const username of [" alice", "alice ", "\talice", "alice　", " "]) {
    assert.deepEqual(await setName(a, "user1", username), { success: false, userError: { error: "USERNAME_HAS_SURROUNDING_WHITESPACE" } }, JSON.stringify(username));
  }
  assert.deepEqual(await setName(a, "user1", "alice smith"), { success: true, previousUsername: null });
});

test("setUsername rejects malformed characters", async (t) => {
  const a = await openAuth(t);
  const malformed = {
    "a NUL character": "ali\u0000ce",
    "a line feed": "ali\nce",
    "a delete character": "ali\u007fce",
    "a C1 control": "ali\u009dce",
    "a right-to-left override": "ali‮ce",
    "a zero-width space": "ali​ce",
    "a byte order mark": "ali﻿ce",
    "a no-break space": "ali ce",
    "an ideographic space": "ali　ce",
    "a noncharacter": "ali￾ce",
    "a plane-end noncharacter": "ali\u{1fffe}ce",
    "an unpaired surrogate": "ali\ud800ce",
    "a leading combining mark": "́alice",
  };
  for (const [description, username] of Object.entries(malformed)) {
    assert.deepEqual(await setName(a, "user1", username), { success: false, userError: { error: "USERNAME_HAS_INVALID_CHARACTERS" } }, description);
  }
});

test("setUsername accepts usernames of all scripts and an astral character", async (t) => {
  const a = await openAuth(t);
  const accepted = ["أحمد", "中文名", "Алиса", "ひらがな", "Renée-Élise", "user_name.42", "family\u{1f468}‍\u{1f469}‍\u{1f466}", "😀"];
  let index = 0;
  for (const username of accepted) assert.deepEqual(await setName(a, `user${index++}`, username), { success: true, previousUsername: null }, username);
});

test("usernames compare across Unicode normalization forms and store the spelling given", async (t) => {
  const a = await openAuth(t);
  const composed = "café";
  const decomposed = "café";
  assert.notEqual(composed, decomposed);
  await setName(a, "user1", composed);
  assert.equal(await idOf(a, decomposed), "user1");
  assert.deepEqual(await setName(a, "user2", decomposed), { success: false, userError: { error: "USERNAME_TAKEN" } });
  await setName(a, "user3", "AlIcE");
  const [row] = (await rows(a, usernameTables.usernames)).filter((r) => r.userId === "user3");
  assert.equal(row.username, "AlIcE");
  assert.equal(row.usernameNormalized, "alice");
});

test("getUserIdByUsername ignores case and returns null for an unknown username; getUsername for an unknown user", async (t) => {
  const a = await openAuth(t);
  await setName(a, "user1", "Alice");
  assert.equal(await idOf(a, "ALICE"), "user1");
  assert.equal(await idOf(a, "alice"), "user1");
  assert.equal(await idOf(a, "nobody"), null);
  assert.equal(await nameOf(a, "nobody"), null);
});

test("deleteUsername deletes only the given user's, frees the name, and is idempotent", async (t) => {
  const a = await openAuth(t);
  await setName(a, "user1", "alice");
  await setName(a, "user2", "bob");
  assert.deepEqual(await mutate(a, (tx) => deleteUsername(tx, { userId: "user1" })), { deleted: true });
  assert.equal(await nameOf(a, "user1"), null);
  assert.equal(await idOf(a, "alice"), null);
  assert.equal(await nameOf(a, "user2"), "bob");
  assert.deepEqual(await setName(a, "user3", "alice"), { success: true, previousUsername: null });
  assert.deepEqual(await mutate(a, (tx) => deleteUsername(tx, { userId: "nobody" })), { deleted: false });
});

test("two concurrent claims of one username leave exactly one owner", async (t) => {
  const a = await openAuth(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => setName(a, `user${index}`, "Contested")));
  assert.equal(results.filter((r) => r.success).length, 1);
  assert.equal(results.filter((r) => !r.success && r.userError.error === "USERNAME_TAKEN").length, 7);
  assert.equal((await rows(a, usernameTables.usernames)).length, 1);
});

// --- password module (upstream components/password/passwordProvider.test.ts) ----------------------------------

test("a password set is verified; a wrong one is not", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", PASSWORD);
  assert.deepEqual(await verify(a, "alice", PASSWORD), { success: true });
  assert.deepEqual(await verify(a, "alice", "wrong horse battery staple"), { success: false, userError: { error: "INVALID_CREDENTIALS" } });
});

test("verifying an unknown user id is a defect, and consumes no token", async (t) => {
  const a = await openAuth(t);
  await assert.rejects(a.run(a.core.mutation(CALL, (tx) => beginVerify(tx, { userId: "nobody", password: PASSWORD }))), /No password stored for userId nobody/);
});

test("setting a password again replaces the old one", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", PASSWORD);
  const next = "a whole new password here";
  await setPassword(a, "alice", next);
  assert.equal((await rows(a, passwordTables.passwords)).length, 1);
  assert.deepEqual(await verify(a, "alice", next), { success: true });
  assert.deepEqual(await verify(a, "alice", PASSWORD), { success: false, userError: { error: "INVALID_CREDENTIALS" } });
});

test("verification rejects a malformed input before it looks at the hash", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", PASSWORD);
  assert.deepEqual(await verify(a, "alice", "short"), { success: false, userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 } });
  assert.deepEqual(await verify(a, "alice", "a".repeat(MAX_PASSWORD_LENGTH + 1)), { success: false, userError: { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH } });
  assert.deepEqual(await verify(a, "alice", " leadingspace123"), { success: false, userError: { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" } });
});

test("a user with a frequent password from before the rule can still sign in", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", "password123");
  assert.deepEqual(await verify(a, "alice", "password123"), { success: true });
});

test("verification works across Unicode normalization forms", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", "café password test");
  assert.deepEqual(await verify(a, "alice", "café password test"), { success: true });
});

test("the sixth attempt within a minute is RATE_LIMITED, and a minute later one is allowed", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", PASSWORD);
  for (let i = 0; i < 5; i += 1) await verify(a, "alice", "wrong horse battery staple");
  const limited = await verify(a, "alice", PASSWORD);
  assert.equal(limited.success, false);
  assert.equal(limited.userError.error, "RATE_LIMITED");
  assert.equal(typeof limited.userError.retryAfterMs, "number");
  assert.ok(limited.userError.retryAfterMs > 0 && limited.userError.retryAfterMs <= 60_000);
  a.clock.now += 61_000;
  assert.deepEqual(await verify(a, "alice", PASSWORD), { success: true });
  // Another user's bucket is untouched.
  await setPassword(a, "bob", PASSWORD);
  assert.deepEqual(await verify(a, "bob", PASSWORD), { success: true });
});

test("finishVerify refuses a hash that is no longer the stored one, and replaces an old hash in the same commit", async (t) => {
  const a = await openAuth(t);
  await setPassword(a, "alice", PASSWORD);
  const begun = await mutate(a, (tx) => beginVerify(tx, { userId: "alice", password: PASSWORD }));
  await setPassword(a, "alice", "changed in between!!");
  assert.deepEqual(await mutate(a, (tx) => finishVerify(tx, { userId: "alice", stored: begun.stored })), { success: false, userError: { error: "INVALID_CREDENTIALS" } });
  const again = await mutate(a, (tx) => beginVerify(tx, { userId: "alice", password: "changed in between!!" }));
  const rehashed = await a.run(hashPassword("changed in between!!"));
  assert.deepEqual(await mutate(a, (tx) => finishVerify(tx, { userId: "alice", stored: again.stored, rehashed })), { success: true });
  const [row] = await rows(a, passwordTables.passwords);
  assert.equal(row.passwordHashPHC, rehashed);
});

// --- validation (upstream validation.test.ts and commonPasswords.test.ts) ---------------------------------------

test("validatePasswordInputFormat applies minimumLength and refuses a minimumLength outside its range", () => {
  assert.deepEqual(validatePasswordInputFormat("kY7t-vQ2m", 10), { error: "PASSWORD_TOO_SHORT", minimumLength: 10 });
  assert.equal(validatePasswordInputFormat("kY7t-vQ2m", 9), null);
  assert.equal(validatePasswordInputFormat("kY7t-vQ2m", MIN_PASSWORD_LENGTH), null);
  assert.equal(validatePasswordInputFormat("a".repeat(MAX_PASSWORD_LENGTH), MAX_PASSWORD_LENGTH), null);
  for (const minimumLength of [MIN_PASSWORD_LENGTH - 1, 0, MAX_PASSWORD_LENGTH + 1, NaN]) {
    const message = `minimumLength must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH}`;
    assert.throws(() => validatePasswordInputFormat("kY7t-vQ2m", minimumLength), new RegExp(message));
    assert.throws(() => validateNewPassword("kY7t-vQ2m", minimumLength), new RegExp(message));
  }
});

test("validateNewPassword rejects short, whitespace-padded and common passwords, in any case", () => {
  assert.deepEqual(validateNewPassword("short", MIN_PASSWORD_LENGTH), { error: "PASSWORD_TOO_SHORT", minimumLength: 8 });
  assert.equal(validateNewPassword("kY7t-vQ2", MIN_PASSWORD_LENGTH), null);
  assert.deepEqual(validateNewPassword("12345678", MIN_PASSWORD_LENGTH), { error: "PASSWORD_TOO_COMMON" });
  assert.deepEqual(validateNewPassword("password123", MIN_PASSWORD_LENGTH), { error: "PASSWORD_TOO_COMMON" });
  assert.deepEqual(validateNewPassword("Password123", MIN_PASSWORD_LENGTH), { error: "PASSWORD_TOO_COMMON" });
  assert.deepEqual(validateNewPassword(" leadingspace123", MIN_PASSWORD_LENGTH), { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" });
  assert.equal(DEFAULT_MIN_PASSWORD_LENGTH, 15);
});

test("the common-password list is well-formed and isCommonPassword finds its entries", () => {
  const all = Object.values(COMMON_PASSWORDS_BY_LENGTH).flat();
  // The list was generated for upstream's minimum of 10; Zelavis's methods require 15, so it only bites above that.
  assert.equal(all.filter((password) => [...password].length >= 10).length, 3000);
  for (const password of all) {
    assert.ok([...password].length >= MIN_PASSWORD_LENGTH);
    assert.equal(password, password.normalize("NFC").toLowerCase());
  }
  for (const [length, bucket] of Object.entries(COMMON_PASSWORDS_BY_LENGTH)) {
    assert.deepEqual(bucket, [...bucket].sort());
    for (const password of bucket) assert.equal([...password].length, Number(length));
  }
  assert.equal(new Set(all).size, all.length);
  for (const password of all) assert.equal(isCommonPassword(password), true, password);
  assert.equal(isCommonPassword("correct horse battery staple"), false);
  assert.equal(isCommonPassword("kY7t-vQ2mZ0x"), false);
  assert.equal(isCommonPassword("QwErTyUiOp"), true);
  assert.equal(isCommonPassword("passwor"), false);
  assert.equal(isCommonPassword(""), false);
  assert.equal(isCommonPassword("cafécafécafé".normalize("NFD")), false);
});

// --- the method and its routes ---------------------------------------------------------------------------------

async function compose(t, options = {}) {
  const a = await openAuth(t, options);
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
  const call = (path, { method = "GET", headers = {}, body } = {}) => runtime.fetch(new Request(`${ORIGIN}/auth/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const post = (path, body, headers) => call(path, { method: "POST", body, headers });
  const bearer = (bundle) => ({ authorization: `Bearer ${bundle.accessToken}` });
  const signUp = async (username, password) => (await (await post("username-password/sign-up", { username, password })).json());
  return { ...a, runtime, call, post, bearer, signUp };
}

const json = async (response, status) => {
  assert.equal(response.status, status, `expected ${status}, got ${response.status}`);
  return response.json();
};

test("every user error the ported Schemas declare has an HTTP mapping", async () => {
  const { setPasswordUserError, verifyPasswordUserError } = await import("../dist/auth/password/validation.js");
  const { setUsernameUserError } = await import("../dist/auth/username/validation.js");
  assert.doesNotThrow(() => assertUserErrorsCovered(setUsernameUserError, setPasswordUserError, verifyPasswordUserError));
  assert.throws(() => assertUserErrorsCovered({ members: [{ fields: { error: { literal: "NEW_CODE_NOBODY_MAPPED" } } }] }), /NEW_CODE_NOBODY_MAPPED/);
  assert.throws(() => assertUserErrorsCovered({}), /found no error codes/);
});

test("sign-up creates the account, username, password and session in one commit; bearer clients get tokens", async (t) => {
  const a = await compose(t);
  const body = await json(await a.post("username-password/sign-up", { username: "Alice", password: PASSWORD }), 200);
  assert.equal(body.status, "complete");
  assert.equal(body.tokens.userId, body.userId);
  assert.equal((await rows(a, accountsTables.accounts)).length, 1);
  assert.equal((await rows(a, coreTables.sessions)).length, 1);
  assert.equal((await rows(a, usernameTables.usernames)).length, 1);
  assert.equal((await rows(a, passwordTables.passwords)).length, 1);
  const session = await json(await a.call("session", { headers: a.bearer(body.tokens) }), 200);
  assert.equal(session.account.id, body.userId);
  const [stored] = await rows(a, passwordTables.passwords);
  assert.match(stored.passwordHashPHC, /^\$pbkdf2-sha256\$i=600000\$/);
  assert.ok(!JSON.stringify(await rows(a, passwordTables.passwords)).includes(PASSWORD), "the password is never stored");
});

test("a browser page of this origin gets cookies and no tokens", async (t) => {
  const a = await compose(t);
  const response = await a.post("username-password/sign-up", { username: "alice", password: PASSWORD }, { origin: ORIGIN });
  const body = await json(response, 200);
  assert.equal(body.tokens, undefined);
  assert.equal(typeof body.userId, "string");
  const lines = response.headers.getSetCookie();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes("HttpOnly")));
  assert.ok(lines.some((line) => line.startsWith("zelavis_access=")) && lines.some((line) => line.startsWith("zelavis_refresh=")));
  // A cross-origin page, or an SDK that sends a bearer, is not cookie mode.
  const other = await a.post("username-password/sign-in", { username: "alice", password: PASSWORD }, { origin: "https://evil.example" });
  assert.equal((await json(other, 200)).tokens.userId, body.userId);
  assert.equal(other.headers.getSetCookie().length, 0);
});

test("a taken username answers 409 username_taken and writes nothing", async (t) => {
  const a = await compose(t);
  await json(await a.post("username-password/sign-up", { username: "Alice", password: PASSWORD }), 200);
  const body = await json(await a.post("username-password/sign-up", { username: "alice", password: "another valid password" }), 409);
  assert.equal(body.code, "username_taken");
  assert.equal((await rows(a, accountsTables.accounts)).length, 1);
  assert.equal((await rows(a, coreTables.sessions)).length, 1);
  assert.equal((await rows(a, passwordTables.passwords)).length, 1);
});

test("passwords under 15 characters, padded with whitespace or on the common list are refused at sign-up", async (t) => {
  const a = await compose(t);
  const short = await json(await a.post("username-password/sign-up", { username: "alice", password: "x".repeat(14) }), 400);
  assert.equal(short.code, "password_too_short");
  assert.equal(short.minimumLength, 15);
  assert.equal((await json(await a.post("username-password/sign-up", { username: "alice", password: "123456789qwerty" }), 400)).code, "password_too_common");
  assert.equal((await json(await a.post("username-password/sign-up", { username: "alice", password: ` ${PASSWORD}` }), 400)).code, "password_has_surrounding_whitespace");
  assert.equal((await json(await a.post("username-password/sign-up", { username: " alice", password: PASSWORD }), 400)).code, "username_has_surrounding_whitespace");
  assert.equal((await json(await a.post("username-password/sign-up", { username: "alice" }), 400)).code, "invalid_request");
  assert.equal((await rows(a, accountsTables.accounts)).length, 0, "no refused attempt created anything");
});

test("sign-in: a wrong password is 401, an unknown username 404, the sixth wrong attempt 429 with retry-after", async (t) => {
  const a = await compose(t);
  await a.signUp("alice", PASSWORD);
  assert.equal((await json(await a.post("username-password/sign-in", { username: "nobody", password: PASSWORD }), 404)).code, "user_not_found");
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await json(await a.post("username-password/sign-in", { username: "Alice", password: "wrong horse battery staple" }), 401)).code, "invalid_credentials");
  }
  const limited = await a.post("username-password/sign-in", { username: "alice", password: PASSWORD });
  assert.equal((await json(limited, 429)).code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  a.clock.now += 61_000;
  const ok = await json(await a.post("username-password/sign-in", { username: "alice", password: PASSWORD }), 200);
  assert.equal(ok.status, "complete");
});

test("a legacy hash signs in and is a PHC hash in the commit that creates the session", async (t) => {
  const a = await compose(t);
  const signedUp = await a.signUp("alice", PASSWORD);
  const [row] = await rows(a, passwordTables.passwords);
  await a.run(a.auth.runtime.mutation(CALL, (tx) => tx.db.patch(passwordTables.passwords, row._id, { passwordHashPHC: BCRYPT_LEGACY })));
  const sessionsBefore = (await rows(a, coreTables.sessions)).length;
  assert.equal((await json(await a.post("username-password/sign-in", { username: "alice", password: "wrong legacy password" }), 401)).code, "invalid_credentials");
  assert.equal((await rows(a, passwordTables.passwords))[0].passwordHashPHC, BCRYPT_LEGACY, "a failed attempt does not rehash");
  const ok = await json(await a.post("username-password/sign-in", { username: "alice", password: LEGACY_PASSWORD }), 200);
  assert.equal(ok.userId, signedUp.userId);
  assert.match((await rows(a, passwordTables.passwords))[0].passwordHashPHC, /^\$pbkdf2-sha256\$i=600000\$/);
  assert.equal((await rows(a, coreTables.sessions)).length, sessionsBefore + 1);
  // The same password signs in again, now against the PHC hash.
  a.clock.now += 61_000;
  assert.equal((await json(await a.post("username-password/sign-in", { username: "alice", password: LEGACY_PASSWORD }), 200)).status, "complete");
});

test("a password changed between verification and the commit fails the sign-in and issues no session", async (t) => {
  const a = await openAuth(t);
  await a.run(a.auth.methods.usernamePassword.signUpWithUsernamePassword(CALL, { username: "alice", password: PASSWORD }));
  // A second method bound over the same core, whose second transaction (the one that issues the session) is
  // preceded by a recovery-like change of the password.
  const core = {
    ...a.auth.core,
    bindMethod: (options) => {
      const bound = a.auth.core.bindMethod({ ...options, name: "raceMethod" });
      let calls = 0;
      return {
        ...bound,
        mutation: (call, body) => {
          calls += 1;
          if (calls !== 2) return bound.mutation(call, body);
          return Effect.flatMap(
            Effect.promise(() => setPassword(a, a.userIdOf, "changed in the meantime!!")),
            () => bound.mutation(call, body),
          );
        },
      };
    },
  };
  a.userIdOf = (await read(a, (tx) => getUserIdByUsername(tx, { username: "alice" })));
  const sessionsBefore = (await rows(a, coreTables.sessions)).length;
  const result = await a.run(setupUsernamePassword(core).signInWithUsernamePassword(CALL, { username: "alice", password: PASSWORD }));
  assert.deepEqual(result, { status: "error", userError: { error: "INVALID_CREDENTIALS" } });
  assert.equal((await rows(a, coreTables.sessions)).length, sessionsBefore, "no session was issued");
});

test("change password: needs a session and the current password, and ends the other sessions", async (t) => {
  const a = await compose(t);
  const first = (await json(await a.post("username-password/sign-up", { username: "alice", password: PASSWORD }), 200)).tokens;
  const second = (await json(await a.post("username-password/sign-in", { username: "alice", password: PASSWORD }), 200)).tokens;
  const change = (headers, body) => a.post("username-password/change-password", body, headers);
  const fresh = "a brand new password here";

  assert.equal((await json(await change({}, { currentPassword: PASSWORD, newPassword: fresh }), 401)).code, "not_signed_in");
  assert.equal((await json(await change(a.bearer(first), { currentPassword: "wrong horse battery staple", newPassword: fresh }), 401)).code, "invalid_credentials");
  // A bad new password is refused before the current one is looked at.
  assert.equal((await json(await change(a.bearer(first), { currentPassword: PASSWORD, newPassword: "short" }), 400)).code, "password_too_short");
  assert.equal((await json(await change(a.bearer(first), { currentPassword: PASSWORD }), 400)).code, "invalid_request");

  assert.deepEqual(await json(await change(a.bearer(first), { currentPassword: PASSWORD, newPassword: fresh }), 200), { success: true });
  assert.equal((await a.call("session", { headers: a.bearer(second) })).status, 401, "the other session ended");
  assert.equal((await a.call("session", { headers: a.bearer(first) })).status, 200, "this session continues");
  a.clock.now += 61_000;
  assert.equal((await json(await a.post("username-password/sign-in", { username: "alice", password: PASSWORD }), 401)).code, "invalid_credentials");
  assert.equal((await json(await a.post("username-password/sign-in", { username: "alice", password: fresh }), 200)).status, "complete");
});

test("change password as a session ended meanwhile is not_signed_in", async (t) => {
  const a = await compose(t);
  const bundle = (await json(await a.post("username-password/sign-up", { username: "alice", password: PASSWORD }), 200)).tokens;
  await a.run(a.auth.core.signOut(CALL, { refreshToken: bundle.refreshToken }));
  const response = await a.post("username-password/change-password", { currentPassword: PASSWORD, newPassword: "a brand new password here" }, a.bearer(bundle));
  assert.equal((await json(response, 401)).code, "not_signed_in");
  assert.deepEqual(await verify(a, (await rows(a, passwordTables.passwords))[0].userId, PASSWORD), { success: true }, "the password is unchanged");
});

test("8 concurrent sign-ups for one username create exactly one account", async (t) => {
  const a = await compose(t);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => a.post("username-password/sign-up", { username: "Contested", password: `${PASSWORD} ${index}` })));
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  assert.equal((await rows(a, accountsTables.accounts)).length, 1);
  assert.equal((await rows(a, usernameTables.usernames)).length, 1);
  assert.equal((await rows(a, passwordTables.passwords)).length, 1);
});
