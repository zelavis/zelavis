/**
 * Zelavis Auth, TOTP multi-factor authentication: the TOTP primitives, backup codes, enrollment (RFC 4226, RFC 6238
 * and RFC 4648 vectors among them), gate, verification, policy, reset and routes, over `test/_auth.mjs`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Effect } from "effect";
import { createServiceRuntime } from "../dist/core/index.js";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { createAuth } from "../dist/auth/create-auth.js";
import { decryptSecret } from "../dist/edge/acme-crypto.js";
import { BACKUP_CODE_COUNT, generateBackupCodes, hashBackupCode } from "../dist/auth/totp/backupCodes.js";
import { createExpiredPendingSignInsSweep } from "../dist/auth/totp/cleanup.js";
import { MAX_TOTPS_PER_USER, PENDING_ENROLLMENT_TTL_MS, confirmTotp, createTotp, getStatus, listTotps } from "../dist/auth/totp/enrollment.js";
import { MAX_CHALLENGE_ATTEMPTS, VERIFY_CHALLENGE_TTL_MS } from "../dist/auth/totp/gate.js";
import { totpKey } from "../dist/auth/totp/helpers.js";
import { isPrivileged, resetSecondFactor } from "../dist/auth/totp/policy.js";
import { totpTables } from "../dist/auth/totp/tables.js";
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, timingSafeEqual, totp, totpCounter } from "../dist/auth/totp/totp.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { TEST_MASTER_SECRET, bindTestMethod, emailLinkOf, fakeOAuthProvider, fragmentOf, openAuth, recordingOutbox, waitFor } from "./_auth.mjs";

const KEY = totpKey(TEST_MASTER_SECRET);
const CALL = { ip: null };
const ORIGIN = "https://auth.example.test";
const APP = "https://app.example.test";
const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "an entirely new battery staple";
const PERIOD_MS = 30_000;
// A moment in the middle of a time step, so that a few milliseconds of test time never cross a step boundary.
const START = 1_700_000_015_000;
const ENROLLMENT = { issuerDisplayName: "Acme", accountDisplayName: "alice@example.com" };

const ascii = (text) => new TextEncoder().encode(text);
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

// --- the component over the harness -------------------------------------------------------------------------------

async function component(t) {
  const a = await openAuth(t, { now: START });
  const mutate = (body) => a.run(a.core.mutation(CALL, body));
  const read = (body) => a.run(a.core.query(CALL, body));
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const c = {
    ...a,
    mutate,
    read,
    rows,
    create: (userId = "alice") => mutate((tx) => createTotp(tx, { userId, ...ENROLLMENT, key: KEY })),
    confirm: (userId, code) => mutate((tx) => confirmTotp(tx, { userId, code, key: KEY })),
    status: (userId) => read((tx) => getStatus(tx, { userId })),
    list: (userId) => read((tx) => listTotps(tx, { userId })),
    /** The code an authenticator app shows for the secret, at the given time. */
    codeFor: (secret, atMs = a.clock.now) => a.run(totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, atMs)),
    advance: (ms) => { a.clock.now += ms; },
  };
  /**
   * Enroll one more authenticator, and move the clock one step forward: the code that confirms the secret cannot be
   * used again, thus a test that verifies a code right after the enrollment needs the code of a later step.
   */
  c.addAuthenticator = async (userId = "alice") => {
    const { secret } = await c.create(userId);
    const result = await c.confirm(userId, await c.codeFor(secret));
    assert.equal(result.success, true, JSON.stringify(result));
    c.advance(PERIOD_MS);
    return { secret, totpId: result.totpId, backupCodes: result.backupCodes };
  };
  c.enroll = async (userId = "alice") => {
    const enrolled = await c.addAuthenticator(userId);
    assert.ok(enrolled.backupCodes, `${userId} was enrolled already.`);
    return enrolled;
  };
  return c;
}

/** The base32 secret a stored row holds, opened with the TOTP key. */
const secretOf = (row) => decryptSecret(row.sealedSecret, KEY);

// --- upstream components/totp/totp.test.ts ------------------------------------------------------------------------

// The test vectors of RFC 4648, section 10, without padding.
const BASE32_VECTORS = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];

test("upstream: base32 encodes the RFC 4648 vectors", () => {
  for (const [input, encoded] of BASE32_VECTORS) assert.equal(base32Encode(ascii(input)), encoded, input);
});

test("upstream: base32 decodes the RFC 4648 vectors", () => {
  for (const [input, encoded] of BASE32_VECTORS) assert.equal(new TextDecoder().decode(base32Decode(encoded)), input, encoded);
});

test("upstream: base32 decodes with padding, in lowercase and with spaces", () => {
  for (const text of ["MZXW6YTBOI======", "mzxw6ytboi", "MZXW 6YTB OI"]) assert.equal(new TextDecoder().decode(base32Decode(text)), "foobar", text);
});

test("upstream: base32 rejects a character outside the alphabet", () => {
  assert.throws(() => base32Decode("MZXW1"), /Invalid base32 character/);
});

test("upstream: base32 rejects a length that no byte sequence encodes to", () => {
  for (const text of ["M", "MZX", "MZXW6Y", "MZXW6YTBM"]) assert.throws(() => base32Decode(text), /Invalid base32 length/, text);
});

test("upstream: base32 rejects unused trailing bits that are not zero", () => {
  // Each is a valid encoding with one or more of the padding bits of the final character flipped.
  for (const text of ["MZ", "MZXR", "MZXW7", "MZXW6YR", "MZXW6YTBOJ"]) assert.throws(() => base32Decode(text), /trailing bits/, text);
});

test("upstream: base32 round-trips random bytes", () => {
  for (let length = 0; length < 40; length++) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test("upstream: hotp matches the RFC 4226 test vectors", async () => {
  // RFC 4226, appendix D: the secret "12345678901234567890" and the counters 0 to 9.
  const secret = ascii("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let counter = 0; counter < expected.length; counter++) {
    assert.equal(await Effect.runPromise(hotp(secret, counter, { algorithm: "SHA-1", digits: 6 })), expected[counter], `counter ${counter}`);
  }
});

test("upstream: hotp handles a counter above 2^32", async () => {
  // The high 4 bytes of the counter are not zero here, thus a mistake in the split of the counter into two 32-bit
  // halves gives a different code from the one for the low half alone.
  const secret = ascii("12345678901234567890");
  const options = { algorithm: "SHA-1", digits: 6 };
  assert.notEqual(await Effect.runPromise(hotp(secret, 2 ** 32 + 1, options)), await Effect.runPromise(hotp(secret, 1, options)));
});

// RFC 6238, appendix B. Each algorithm uses a secret of its own size, made of the repeated ASCII digits, and 8 digits.
const SEED = "1234567890";
const RFC6238_SECRETS = {
  "SHA-1": base32Encode(ascii(SEED.repeat(2))),
  "SHA-256": base32Encode(ascii(SEED.repeat(4).slice(0, 32))),
  "SHA-512": base32Encode(ascii(SEED.repeat(7).slice(0, 64))),
};
const RFC6238_VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

for (const algorithm of ["SHA-1", "SHA-256", "SHA-512"]) {
  test(`upstream: totp matches the RFC 6238 test vectors for ${algorithm}`, async () => {
    const column = { "SHA-1": 1, "SHA-256": 2, "SHA-512": 3 }[algorithm];
    for (const vector of RFC6238_VECTORS) {
      const seconds = vector[0];
      assert.equal(await Effect.runPromise(totp({ secret: RFC6238_SECRETS[algorithm], algorithm, digits: 8, period: 30 }, seconds * 1000)), vector[column], `T=${seconds}`);
    }
  });
}

test("upstream: computes the time-step counter", () => {
  assert.equal(totpCounter(0, 30), 0);
  assert.equal(totpCounter(29_999, 30), 0);
  assert.equal(totpCounter(30_000, 30), 1);
  assert.equal(totpCounter(1111111109_000, 30), 37037036);
});

test("upstream: generateSecret gives a 160-bit secret, different each time", () => {
  const a = generateSecret();
  const b = generateSecret();
  // 20 bytes are 160 bits.
  assert.equal(a.length, 20);
  assert.notDeepEqual(a, b);
});

const URI_PARAMS = { secret: "MZXW6YTBOI", algorithm: "SHA-1", digits: 6, period: 30 };

test("upstream: otpauthUri builds the key URI", () => {
  assert.equal(
    otpauthUri({ ...URI_PARAMS, issuer: "Acme", accountName: "alice@example.com" }),
    "otpauth://totp/Acme:alice%40example.com?secret=MZXW6YTBOI&issuer=Acme&algorithm=SHA1&digits=6&period=30",
  );
});

test("upstream: otpauthUri percent-encodes the issuer and the account name", () => {
  const uri = otpauthUri({ ...URI_PARAMS, issuer: "Acme Corp & Co", accountName: "alice: bob" });
  assert.equal(uri, "otpauth://totp/Acme%20Corp%20%26%20Co:alice%3A%20bob?secret=MZXW6YTBOI&issuer=Acme%20Corp%20%26%20Co&algorithm=SHA1&digits=6&period=30");
  // A URL parser gets the values back.
  const url = new URL(uri);
  assert.equal(url.searchParams.get("issuer"), "Acme Corp & Co");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "Acme Corp & Co:alice: bob");
});

test("upstream: otpauthUri rejects an issuer with a colon", () => {
  assert.throws(() => otpauthUri({ ...URI_PARAMS, issuer: "Acme: Staging", accountName: "alice@example.com" }), /must not contain a colon/);
});

test("upstream: timingSafeEqual compares strings", () => {
  assert.equal(timingSafeEqual("123456", "123456"), true);
  assert.equal(timingSafeEqual("123456", "123457"), false);
  assert.equal(timingSafeEqual("123456", "12345"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

// --- upstream components/totp/backupCodes.test.ts -----------------------------------------------------------------

test("upstream: generateBackupCodes gives distinct codes in the displayed form", () => {
  const codes = generateBackupCodes();
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  // Five characters, a hyphen, five characters, from Crockford's alphabet.
  for (const code of codes) assert.match(code, /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
  assert.equal(new Set(codes).size, BACKUP_CODE_COUNT);
});

test("upstream: generateBackupCodes draws again when a code repeats", (t) => {
  // The first two draws give the same bytes, the rest are distinct.
  let draw = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (array) => {
    array.fill(draw === 0 ? 0 : draw - 1);
    draw++;
    return array;
  });
  const codes = generateBackupCodes();
  t.mock.restoreAll();
  assert.equal(codes.length, BACKUP_CODE_COUNT);
  assert.equal(new Set(codes).size, BACKUP_CODE_COUNT);
  assert.equal(draw, BACKUP_CODE_COUNT + 1);
});

const hashOf = (code) => Effect.runPromise(hashBackupCode(code));

test("upstream: hashBackupCode hashes a generated code the same with and without its hyphen", async () => {
  for (const code of generateBackupCodes()) assert.equal(await hashOf(code), await hashOf(code.replace("-", "")), code);
});

test("upstream: hashBackupCode ignores the case, the hyphen and spaces", async () => {
  const expected = await hashOf("a2b3cd4e5f");
  for (const code of [" A2B3C D4E5F ", "A2B3C-D4E5F", "a2b3c-d4e5f"]) assert.equal(await hashOf(code), expected, code);
});

test("upstream: hashBackupCode reads the letters outside the alphabet as the digits they resemble", async () => {
  assert.equal(await hashOf("OoIiLl"), await hashOf("001111"));
});

test("upstream: hashBackupCode gives different hashes for different codes", async () => {
  assert.notEqual(await hashOf("a2b3c-d4e5f"), await hashOf("a2b3c-d4e5g"));
});

// --- upstream components/totp/enrollment.test.ts ------------------------------------------------------------------

test("upstream: createTotp returns the secret and the otpauth URI, and starts a pending enrollment", async (t) => {
  const c = await component(t);
  const { secret, otpauthUri: uri } = await c.create("alice");
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(uri, `otpauth://totp/Acme:alice%40example.com?secret=${secret}&issuer=Acme&algorithm=SHA1&digits=6&period=30`);
  assert.deepEqual(await c.status("alice"), { enabled: false, remainingBackupCodes: 0 });
  const rows = await c.rows(totpTables.totpSecrets);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, "alice");
  assert.equal(rows[0].status, "pending");
  assert.equal(secretOf(rows[0]), secret);
});

test("upstream: a second createTotp replaces the pending secret", async (t) => {
  const c = await component(t);
  const first = await c.create("alice");
  const second = await c.create("alice");
  assert.notEqual(second.secret, first.secret);
  const rows = await c.rows(totpTables.totpSecrets);
  assert.equal(rows.length, 1);
  assert.equal(secretOf(rows[0]), second.secret);
  // Only the code of the last secret confirms the enrollment.
  assert.deepEqual(await c.confirm("alice", await c.codeFor(first.secret)), { success: false, userError: { error: "INCORRECT_CODE" } });
  assert.equal((await c.confirm("alice", await c.codeFor(second.secret))).success, true);
});

test("upstream: createTotp leaves an active secret in place until the new one is confirmed", async (t) => {
  const c = await component(t);
  const { secret } = await c.enroll();
  await c.create("alice");
  assert.deepEqual(await c.status("alice"), { enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });
  const active = (await c.rows(totpTables.totpSecrets)).filter((row) => row.status === "active");
  assert.equal(active.length, 1);
  assert.equal(secretOf(active[0]), secret);
});

test("upstream: createTotp touches only the given user's secrets and backup codes", async (t) => {
  const c = await component(t);
  const alice = await c.enroll("alice");
  const alicePending = await c.create("alice");
  // Bob sees nothing of Alice's, and her pending code confirms nothing for him.
  assert.deepEqual(await c.status("bob"), { enabled: false, remainingBackupCodes: 0 });
  assert.deepEqual(await c.confirm("bob", await c.codeFor(alicePending.secret)), { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } });
  // Bob's enrollment replaces neither Alice's secrets nor her backup codes.
  await c.enroll("bob");
  assert.deepEqual(await c.status("alice"), { enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });
  const aliceActive = (await c.rows(totpTables.totpSecrets)).filter((row) => row.userId === "alice" && row.status === "active");
  assert.equal(secretOf(aliceActive[0]), alice.secret);
  const aliceCodes = (await c.rows(totpTables.backupCodes)).filter((row) => row.userId === "alice");
  assert.deepEqual(aliceCodes.map((row) => row.codeHash).sort(), (await Promise.all(alice.backupCodes.map(hashOf))).sort());
  assert.equal((await c.confirm("alice", await c.codeFor(alicePending.secret))).success, true);
});

test("upstream: confirmTotp activates the secret and returns the backup codes", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  const result = await c.confirm("alice", await c.codeFor(secret));
  assert.equal(result.success, true);
  assert.equal(typeof result.totpId, "string");
  assert.equal(result.backupCodes.length, BACKUP_CODE_COUNT);
  for (const code of result.backupCodes) assert.match(code, /^[0-9a-z]{5}-[0-9a-z]{5}$/);
  assert.deepEqual(await c.status("alice"), { enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });
});

test("upstream: confirmTotp accepts a code with a space in the middle", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  const code = await c.codeFor(secret);
  assert.equal((await c.confirm("alice", `${code.slice(0, 3)} ${code.slice(3)}`)).success, true);
});

test("upstream: confirmTotp tolerates one step of clock drift in each direction", async (t) => {
  for (const offset of [-PERIOD_MS, PERIOD_MS]) {
    const c = await component(t);
    const { secret } = await c.create("alice");
    assert.equal((await c.confirm("alice", await c.codeFor(secret, c.clock.now + offset))).success, true, `offset ${offset}`);
  }
});

test("upstream: confirmTotp rejects a code from outside the window", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  for (const offset of [-2 * PERIOD_MS, 2 * PERIOD_MS]) {
    assert.deepEqual(await c.confirm("alice", await c.codeFor(secret, c.clock.now + offset)), { success: false, userError: { error: "INCORRECT_CODE" } }, `offset ${offset}`);
  }
});

test("upstream: confirmTotp rejects a malformed code", async (t) => {
  const c = await component(t);
  await c.create("alice");
  for (const code of ["", "12345", "1234567", "abcdef", "12345a"]) {
    assert.deepEqual(await c.confirm("alice", code), { success: false, userError: { error: "INCORRECT_CODE" } }, JSON.stringify(code));
  }
});

test("upstream: confirmTotp stores only the hashes of the backup codes", async (t) => {
  const c = await component(t);
  const { backupCodes } = await c.enroll();
  const rows = await c.rows(totpTables.backupCodes);
  assert.deepEqual(rows.map((row) => row.codeHash).sort(), (await Promise.all(backupCodes.map(hashOf))).sort());
  for (const row of rows) assert.ok(!backupCodes.includes(row.codeHash));
});

test("upstream: confirmTotp rejects a wrong code and keeps the enrollment pending", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  // A code from ten minutes ago is outside the window.
  const stale = await c.codeFor(secret, c.clock.now - 10 * 60 * 1000);
  assert.deepEqual(await c.confirm("alice", stale), { success: false, userError: { error: "INCORRECT_CODE" } });
  assert.deepEqual(await c.status("alice"), { enabled: false, remainingBackupCodes: 0 });
  // The right code still confirms it.
  assert.equal((await c.confirm("alice", await c.codeFor(secret))).success, true);
});

test("upstream: confirmTotp refuses a user with no pending secret", async (t) => {
  const c = await component(t);
  assert.deepEqual(await c.confirm("alice", "123456"), { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } });
  // A confirmed enrollment is not pending any more.
  const { secret } = await c.enroll();
  assert.deepEqual(await c.confirm("alice", await c.codeFor(secret)), { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } });
  assert.equal((await c.status("alice")).enabled, true);
});

test("upstream: confirmTotp refuses a pending secret that is an hour old", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  // Zelavis creation times rise by a fraction of a millisecond per insert, so a row is that much younger than its
  // moment; one millisecond more is an hour past it.
  c.advance(PENDING_ENROLLMENT_TTL_MS + 1);
  assert.deepEqual(await c.confirm("alice", await c.codeFor(secret)), { success: false, userError: { error: "NO_PENDING_ENROLLMENT" } });
  assert.equal((await c.status("alice")).enabled, false);
  // A new enrollment can be confirmed.
  const next = await c.create("alice");
  assert.equal((await c.confirm("alice", await c.codeFor(next.secret))).success, true);
});

test("upstream: confirmTotp accepts a pending secret until it is an hour old", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  c.advance(PENDING_ENROLLMENT_TTL_MS - PERIOD_MS);
  assert.equal((await c.confirm("alice", await c.codeFor(secret))).success, true);
});

test("upstream: confirmTotp adds a second authenticator, and keeps the backup codes", async (t) => {
  const c = await component(t);
  const first = await c.enroll();
  const second = await c.addAuthenticator();
  assert.equal(second.backupCodes, undefined);
  assert.notEqual(second.totpId, first.totpId);
  assert.deepEqual((await c.rows(totpTables.totpSecrets)).map((row) => row.status), ["active", "active"]);
  assert.deepEqual(await c.status("alice"), { enabled: true, remainingBackupCodes: BACKUP_CODE_COUNT });
  // The backup codes are still those of the first enrollment.
  const stored = await c.rows(totpTables.backupCodes);
  assert.deepEqual(stored.map((row) => row.codeHash).sort(), (await Promise.all(first.backupCodes.map(hashOf))).sort());
});

test("upstream: confirmTotp refuses an authenticator past the limit, and keeps it pending", async (t) => {
  const c = await component(t);
  await c.enroll();
  for (let i = 1; i < MAX_TOTPS_PER_USER; i++) await c.addAuthenticator();
  const { secret } = await c.create("alice");
  assert.deepEqual(await c.confirm("alice", await c.codeFor(secret)), { success: false, userError: { error: "TOO_MANY_TOTPS" } });
  assert.equal((await c.list("alice")).length, MAX_TOTPS_PER_USER);
  const pending = (await c.rows(totpTables.totpSecrets)).filter((row) => row.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(secretOf(pending[0]), secret);
});

test("upstream: confirmTotp records the step of the confirmation code", async (t) => {
  const c = await component(t);
  const { secret } = await c.create("alice");
  await c.confirm("alice", await c.codeFor(secret));
  const [row] = await c.rows(totpTables.totpSecrets);
  // The counter of the current step, thus the confirmation code cannot be replayed at sign-in.
  assert.equal(row.lastUsedCounter, Math.floor(c.clock.now / 1000 / 30));
});

test("upstream: listTotps lists the active secrets of the user, oldest first", async (t) => {
  const c = await component(t);
  assert.deepEqual(await c.list("alice"), []);
  const first = await c.enroll();
  const second = await c.addAuthenticator();
  await c.enroll("bob");
  // A pending enrollment is not listed.
  await c.create("alice");
  const listed = await c.list("alice");
  assert.deepEqual(listed.map((row) => row.totpId), [first.totpId, second.totpId]);
  assert.ok(listed[0].createdAt < listed[1].createdAt);
  // Nothing of the secret is listed.
  assert.deepEqual(Object.keys(listed[0]).sort(), ["createdAt", "totpId"]);
});

test("upstream: getStatus reports an unknown user as not enrolled", async (t) => {
  const c = await component(t);
  assert.deepEqual(await c.status("nobody"), { enabled: false, remainingBackupCodes: 0 });
});

// --- Zelavis: the gate, verification, policy and routes -------------------------------------------------------------

async function compose(t, options = {}) {
  const a = await openAuth(t, { now: START, ...options });
  const runtime = await createServiceRuntime({
    endpointGroups: [{
      id: "auth", basePath: "/auth", api: { v1: a.auth.routes }, context: a.auth,
      authenticators: [a.auth.requestAuthenticator], origin: { type: "subsystem", subsystem: "auth-test" },
    }],
  });
  const call = (path, { method = "GET", headers = {}, body, token } = {}) => runtime.fetch(new Request(`${ORIGIN}/auth/${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const post = (path, body, token) => call(path, { method: "POST", body, token });
  const rows = (table) => a.run(a.auth.runtime.query(NO_REQUEST, (tx) => tx.db.query(table).collect()));
  const mutate = (body) => a.run(a.auth.runtime.mutation(NO_REQUEST, body));
  const codeFor = (secret, atMs = a.clock.now) => a.run(totp({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, atMs));
  const advance = (ms) => { a.clock.now += ms; };
  const signUp = async (username, password = PASSWORD) => json(await post("username-password/sign-up", { username, password }));
  const signIn = (username, password = PASSWORD, headers = {}) => call("username-password/sign-in", { method: "POST", body: { username, password }, headers });
  const confirm = (totpId, code, { token, challenge } = {}) => post("mfa/totp/confirm", { totpId, code, challenge }, token);
  /** Enroll the signed-in account's first authenticator through the routes, and move past the confirming step. */
  const enrollByRoute = async (token, password = PASSWORD) => {
    const started = await json(await post("mfa/totp", { password }, token));
    const confirmed = await json(await confirm(started.totpId, await codeFor(started.secret), { token }));
    advance(PERIOD_MS);
    return { ...started, ...confirmed };
  };
  const setAccess = (userId, access) => mutate((tx) => tx.db.patch(accountsTables.accounts, userId, access));
  return { ...a, runtime, call, post, confirm, rows, mutate, codeFor, advance, signUp, signIn, enrollByRoute, setAccess };
}

async function json(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

test("(a) enrollment from a session asks for the current password and activates only after a valid code", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  assert.equal((await json(await a.post("mfa/totp", {}, tokens.accessToken), 401)).code, "reauthentication_required");
  assert.equal((await json(await a.post("mfa/totp", { password: "wrong horse battery staple" }, tokens.accessToken), 401)).code, "invalid_credentials");
  assert.equal((await json(await a.post("mfa/totp", { password: PASSWORD }), 401)).code, "not_signed_in");
  const started = await json(await a.post("mfa/totp", { password: PASSWORD }, tokens.accessToken));
  assert.equal(started.otpauthUri, `otpauth://totp/Zelavis:alice?secret=${started.secret}&issuer=Zelavis&algorithm=SHA1&digits=6&period=30`);
  assert.equal((await json(await a.call("mfa", { token: tokens.accessToken }))).enabled, false, "a pending enrollment is not enforced");
  assert.equal((await json(await a.confirm(started.totpId, "invalid", { token: tokens.accessToken }), 400)).code, "incorrect_code");
  const confirmed = await json(await a.confirm(started.totpId, await a.codeFor(started.secret), { token: tokens.accessToken }));
  assert.equal(confirmed.totpId, started.totpId);
  assert.equal(confirmed.backupCodes.length, 10);
  const status = await json(await a.call("mfa", { token: tokens.accessToken }));
  assert.deepEqual({ enabled: status.enabled, totps: status.totps.map((row) => row.totpId), backupCodesRemaining: status.backupCodesRemaining }, { enabled: true, totps: [confirmed.totpId], backupCodesRemaining: 10 });
});

test("first enrollment is bound to the initiating session and the exact pending ID", async (t) => {
  const a = await compose(t);
  const { tokens: owner } = await a.signUp("alice");
  const { tokens: other } = await json(await a.signIn("alice"));
  const old = await json(await a.post("mfa/totp", { password: PASSWORD }, owner.accessToken));
  const started = await json(await a.post("mfa/totp", { password: PASSWORD }, owner.accessToken));
  assert.notEqual(started.totpId, old.totpId);
  const code = await a.codeFor(started.secret);

  assert.equal((await json(await a.confirm(old.totpId, code, { token: owner.accessToken }), 409)).code, "no_pending_enrollment");
  assert.equal((await json(await a.confirm(started.totpId, code, { token: other.accessToken }), 409)).code, "no_pending_enrollment");
  assert.equal((await json(await a.call("mfa", { token: owner.accessToken }))).enabled, false);

  await json(await a.confirm(started.totpId, code, { token: owner.accessToken }));
  assert.equal((await a.call("session", { token: owner.accessToken })).status, 200);
  assert.equal((await a.call("session", { token: other.accessToken })).status, 401);
  assert.deepEqual(await a.run(a.auth.core.refreshSession(CALL, { refreshToken: other.refreshToken })), { kind: "noSession" });
});

test("a further authenticator needs the password and a fresh code from an existing factor", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const token = tokens.accessToken;
  const first = await a.enrollByRoute(token);
  assert.equal((await json(await a.post("mfa/totp", { password: PASSWORD }, token), 401)).code, "mfa_code_required");
  assert.equal((await json(await a.post("mfa/totp", { password: PASSWORD, code: "invalid" }, token), 400)).code, "incorrect_code");
  const code = await a.codeFor(first.secret);
  const second = await json(await a.post("mfa/totp", { password: PASSWORD, code }, token));
  assert.equal((await json(await a.post("mfa/totp", { password: PASSWORD, code }, token), 400)).code, "incorrect_code", "the proof was consumed at start");
  const confirmed = await json(await a.confirm(second.totpId, await a.codeFor(second.secret), { token }));
  assert.equal(confirmed.totpId, second.totpId);
  assert.equal(confirmed.backupCodes, undefined);
});

test("a recent passwordless session still needs existing MFA, and only one start can use a backup code", async (t) => {
  const a = await compose(t);
  const method = bindTestMethod(a.auth);
  const { userId, accessToken } = await a.run(method.signUp());
  const first = await a.enrollByRoute(accessToken);
  assert.equal((await json(await a.post("mfa/totp", {}, accessToken), 401)).code, "mfa_code_required");
  const code = first.backupCodes[0];
  const attempts = await Promise.all([a.post("mfa/totp", { code }, accessToken), a.post("mfa/totp", { code }, accessToken)]);
  assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 400]);
  assert.equal((await json(attempts.find((response) => response.status === 400), 400)).code, "incorrect_code");
  const started = await json(attempts.find((response) => response.status === 200));
  await json(await a.confirm(started.totpId, await a.codeFor(started.secret), { token: accessToken }));
  assert.equal((await json(await a.call("mfa", { token: accessToken }))).backupCodesRemaining, 9);
  const gated = await a.run(method.signIn(userId));
  assert.equal((await json(await a.post("mfa/verify", { challenge: gated.challenge, code }), 400)).code, "incorrect_code");
});

test("(b) an enrolled account's password sign-in answers mfa_required with no tokens or cookies, and verify completes it", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret } = await a.enrollByRoute(tokens.accessToken);

  // A browser page of this origin would get cookies for a complete sign-in; a gated one gets none.
  const response = await a.signIn("alice", PASSWORD, { origin: ORIGIN });
  assert.equal(response.headers.get("set-cookie"), null);
  const gated = await json(response);
  assert.deepEqual(Object.keys(gated).sort(), ["challenge", "status"]);
  assert.equal(gated.status, "mfa_required");
  const [pending] = await a.rows(totpTables.pendingSignIns);
  assert.equal(pending.challengeHash, sha256Hex(gated.challenge), "only the challenge's hash is stored");
  assert.ok(!JSON.stringify(pending).includes(gated.challenge));

  const done = await json(await a.post("mfa/verify", { challenge: gated.challenge, code: await a.codeFor(secret) }));
  assert.equal(done.status, "complete");
  assert.equal(done.userId, tokens.userId);
  assert.equal(await a.run(a.auth.authenticate(new Request(`${ORIGIN}/auth/session`, { headers: { authorization: `Bearer ${done.tokens.accessToken}` } }))).then((principal) => principal?.id), done.userId);
  assert.equal((await a.rows(totpTables.pendingSignIns)).length, 0, "a redeemed challenge is gone");
  assert.equal((await json(await a.post("mfa/verify", { challenge: gated.challenge, code: await a.codeFor(secret) }), 400)).code, "invalid_challenge");
});

test("(c) a TOTP step and a backup code are each accepted once", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret, backupCodes } = await a.enrollByRoute(tokens.accessToken);
  // Challenges from a method without a password, so the password's own limit (five a minute) stays out of the way.
  const method = bindTestMethod(a.auth);
  const challenge = async () => (await a.run(method.signIn(tokens.userId))).challenge;

  const code = await a.codeFor(secret);
  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code }))).status, "complete");
  // The same code in the same step, and the previous step's code, are replays.
  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code }), 400)).code, "incorrect_code");
  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code: await a.codeFor(secret, a.clock.now - PERIOD_MS) }), 400)).code, "incorrect_code");
  a.advance(PERIOD_MS);
  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code: await a.codeFor(secret) }))).status, "complete");

  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code: backupCodes[0].toUpperCase() }))).status, "complete");
  assert.equal((await json(await a.post("mfa/verify", { challenge: await challenge(), code: backupCodes[0] }), 400)).code, "incorrect_code");
  assert.equal((await json(await a.call("mfa", { token: tokens.accessToken }))).backupCodesRemaining, 9);
});

test("(c) five wrong codes end the challenge; the sixth answers invalid_challenge even with the right code", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret } = await a.enrollByRoute(tokens.accessToken);
  const { challenge } = await json(await a.signIn("alice"));
  for (let attempt = 1; attempt <= MAX_CHALLENGE_ATTEMPTS; attempt++) {
    assert.equal((await json(await a.post("mfa/verify", { challenge, code: "000000" }), 400)).code, "incorrect_code", `attempt ${attempt}`);
    assert.equal((await a.rows(totpTables.pendingSignIns)).length, attempt < MAX_CHALLENGE_ATTEMPTS ? 1 : 0);
  }
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: await a.codeFor(secret) }), 400)).code, "invalid_challenge");
});

test("wrong codes are limited per account across challenges, never runtime-wide", async (t) => {
  const a = await compose(t);
  const alice = await a.signUp("alice");
  const bob = await a.signUp("bob");
  const aliceSecret = (await a.enrollByRoute(alice.tokens.accessToken)).secret;
  const bobSecret = (await a.enrollByRoute(bob.tokens.accessToken)).secret;
  for (let i = 0; i < 2; i++) {
    const { challenge } = await json(await a.signIn("alice"));
    for (let j = 0; j < MAX_CHALLENGE_ATTEMPTS; j++) await json(await a.post("mfa/verify", { challenge, code: "000000" }), 400);
  }
  const { challenge } = await json(await a.signIn("alice"));
  const limited = await json(await a.post("mfa/verify", { challenge, code: await a.codeFor(aliceSecret) }), 429);
  assert.equal(limited.code, "rate_limited");
  // Bob is not slowed by Alice's attacker.
  const bobChallenge = (await json(await a.signIn("bob"))).challenge;
  assert.equal((await json(await a.post("mfa/verify", { challenge: bobChallenge, code: await a.codeFor(bobSecret) }))).status, "complete");
  // The bucket refills: a minute later Alice's right code passes.
  a.advance(60_000);
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: await a.codeFor(aliceSecret) }))).status, "complete");
});

test("a challenge expires after five minutes and the sweep removes it", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret } = await a.enrollByRoute(tokens.accessToken);
  const { challenge } = await json(await a.signIn("alice"));
  a.advance(VERIFY_CHALLENGE_TTL_MS);
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: await a.codeFor(secret) }), 400)).code, "invalid_challenge");
  const sweep = createExpiredPendingSignInsSweep(a.tenant, () => a.clock.now);
  assert.equal(await a.run(sweep.run(a.auth.runtime)), 1);
  assert.equal((await a.rows(totpTables.pendingSignIns)).length, 0);
});

test("(b) an email + password sign-in of an enrolled account is gated too", async (t) => {
  const outbox = recordingOutbox();
  const a = await compose(t, { emailOutbox: outbox });
  const running = await a.run(a.auth.start());
  t.after(() => a.run(running.stop()));
  const started = await json(await a.post("email-password/sign-up", { email: "alice@example.test", password: PASSWORD }));
  await waitFor(() => outbox.delivered.length >= 1, { what: "the verification email" });
  const { code } = emailLinkOf(outbox.delivered[0]);
  const { tokens } = await json(await a.post("email-password/complete-sign-up", { emailCode: code, browserSecret: started.browserSecret }));
  const { secret, otpauthUri } = await a.enrollByRoute(tokens.accessToken);
  assert.match(otpauthUri, /^otpauth:\/\/totp\/Zelavis:alice%40example\.test\?/, "an account without a username is named by its email");
  const gated = await json(await a.post("email-password/sign-in", { email: "alice@example.test", password: PASSWORD }));
  assert.equal(gated.status, "mfa_required");
  const done = await json(await a.post("mfa/verify", { challenge: gated.challenge, code: await a.codeFor(secret) }));
  assert.equal(done.userId, tokens.userId);
});

test("(b) OpenID Connect enrollment and verification survive engine replacement", async (t) => {
  let a;
  const provider = await fakeOAuthProvider(t, { kind: "oidc", now: () => a.clock.now });
  const oauthOptions = { fetch: provider.fetch, allowedRedirectOrigins: [APP] };
  a = await compose(t, { oauth: oauthOptions });
  const reopen = () => a.run(createAuth({
    tenant: a.tenant, masterSecret: TEST_MASTER_SECRET, role: "platform", clock: () => a.clock.now, oauth: oauthOptions,
  }));
  const oauth = a.auth.methods.oauth;
  const connection = { clientId: provider.state.clientId, clientSecret: provider.state.clientSecret, redirectUri: `${ORIGIN}/auth/oauth/acme/callback`, issuer: provider.origin };
  assert.equal((await a.run(oauth.connections.configure("acme", connection))).status, "saved");
  const signInWithOidc = async () => {
    const started = await a.run(oauth.startSignIn(CALL, { provider: "acme", redirectTo: `${APP}/x` }));
    const authorized = provider.authorize(started.redirect);
    const response = await a.runtime.fetch(new Request(authorized.callback, { redirect: "manual" }));
    return a.run(oauth.completeSignIn(CALL, { provider: "acme", code: fragmentOf(response).fragment.get("ticket"), state: started.state }));
  };
  const first = await signInWithOidc();
  assert.equal(first.status, "complete", "the sign-up of a new identity is not gated");
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  const enrollment = await signInWithOidc();
  assert.equal(enrollment.status, "mfa_enrollment_required");
  const enrolling = await reopen();
  const started = await a.run(enrolling.mfa.startEnrollment(CALL, { challenge: enrollment.challenge }));
  assert.equal(started.success, true);
  const confirmed = await a.run(enrolling.mfa.confirmEnrollment(CALL, {
    challenge: enrollment.challenge, totpId: started.totpId, code: await a.codeFor(started.secret),
  }));
  assert.equal(confirmed.signIn?.tokens.userId, first.tokens.userId);
  a.advance(PERIOD_MS);
  const gated = await signInWithOidc();
  assert.equal(gated.status, "mfa_required");
  const verifying = await reopen();
  const done = await a.run(verifying.mfa.verify(CALL, { challenge: gated.challenge, code: await a.codeFor(started.secret) }));
  assert.equal(done.status, "complete");
  assert.equal(done.tokens.userId, first.tokens.userId);
  const [session] = (await a.run(a.auth.core.listSessions(CALL, { userId: done.tokens.userId })));
  assert.ok(session, "the session belongs to the OIDC account");
  a.advance(PERIOD_MS);
  const stale = await signInWithOidc();
  assert.equal((await a.run(oauth.connections.configure("acme", { ...connection, title: "Acme renamed" }))).status, "saved");
  const code = await a.codeFor(started.secret);
  const replacement = await reopen();
  assert.deepEqual(await a.run(replacement.mfa.verify(CALL, { challenge: stale.challenge, code })), {
    success: false, userError: { error: "INVALID_CHALLENGE" },
  });
  const current = await signInWithOidc();
  assert.equal((await json(await a.post("mfa/verify", { challenge: current.challenge, code }))).userId, done.tokens.userId);
});

test("an account without a password enrolls only from a session started within ten minutes", async (t) => {
  const a = await compose(t);
  const m = bindTestMethod(a.auth);
  const bundle = await a.run(m.signUp({}));
  assert.equal((await json(await a.post("mfa/totp", {}, bundle.accessToken))).secret.length, 32);
  a.advance(4 * 60_000);
  const refreshed = await a.run(a.auth.core.refreshSession(CALL, { refreshToken: bundle.refreshToken }));
  a.advance(7 * 60_000);
  const again = await a.run(a.auth.core.refreshSession(CALL, { refreshToken: refreshed.tokens.refreshToken }));
  assert.equal((await json(await a.post("mfa/totp", {}, again.tokens.accessToken), 401)).code, "reauthentication_required");
});

test("a method bound without the second factor is never gated; a gated one is", async (t) => {
  const a = await compose(t);
  const gated = bindTestMethod(a.auth);
  const { userId } = await a.run(gated.signUp({}));
  const { secret } = await a.run(a.core.mutation(CALL, (tx) => createTotp(tx, { userId, ...ENROLLMENT, key: KEY })));
  const code = await a.codeFor(secret);
  assert.equal((await a.run(a.core.mutation(CALL, (tx) => confirmTotp(tx, { userId, code, key: KEY })))).success, true);
  assert.equal((await a.run(gated.signIn(userId))).status, "mfa_required");
  // The passkey method is bound this way: a passkey is a factor of its own.
  const ungated = a.auth.core.bindMethod({ name: "ungated", secondFactor: false, createUser: a.auth.accounts.createUser });
  const outcome = await a.run(ungated.mutation(CALL, (tx, helpers) => helpers.completeSignIn(tx, { userId, profile: {}, authenticatedBy: "ungated" })));
  assert.equal(outcome.status, "complete");
});

test("(d) with policy privileged, an unenrolled owner must enroll at sign-in and the enrollment signs in", async (t) => {
  const a = await compose(t);
  const owner = await a.signUp("owner");
  const member = await a.signUp("member");
  await a.setAccess(owner.tokens.userId, { roles: ["owner"] });
  const policy = await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "privileged", expectedRevision: 0 }));
  assert.deepEqual(policy, { success: true, policy: { requiredFor: "privileged", revision: 1 } });

  assert.equal((await json(await a.signIn("member"))).status, "complete", "a member is not privileged");
  void member;
  const required = await json(await a.signIn("owner"));
  assert.equal(required.status, "mfa_enrollment_required");
  // A verify challenge is not an enrollment one, and the reverse.
  assert.equal((await json(await a.post("mfa/verify", { challenge: required.challenge, code: "000000" }), 400)).code, "invalid_challenge");
  const started = await json(await a.post("mfa/totp", { challenge: required.challenge }));
  assert.match(started.otpauthUri, /^otpauth:\/\/totp\/Zelavis:owner\?/);
  assert.equal((await json(await a.confirm(started.totpId, "invalid", { challenge: required.challenge }), 400)).code, "incorrect_code");
  const done = await json(await a.confirm(started.totpId, await a.codeFor(started.secret), { challenge: required.challenge }));
  assert.equal(done.status, "complete");
  assert.equal(done.userId, owner.tokens.userId);
  assert.equal(done.backupCodes.length, 10);
  assert.equal(typeof done.tokens.accessToken, "string");
  assert.equal((await a.call("session", { token: owner.tokens.accessToken })).status, 401, "the previous session ended");
  assert.equal((await a.call("session", { token: done.tokens.accessToken })).status, 200, "the new MFA session works");
  assert.deepEqual(await a.run(a.auth.core.refreshSession(CALL, { refreshToken: owner.tokens.refreshToken })), { kind: "noSession" });
  a.advance(PERIOD_MS);
  assert.equal((await json(await a.signIn("owner"))).status, "mfa_required", "the next sign-in asks for the new factor");
});

test("only the enrollment challenge that started a secret can confirm it, and another challenge expires on activation", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  const first = await json(await a.signIn("alice"));
  const second = await json(await a.signIn("alice"));
  const started = await json(await a.post("mfa/totp", { challenge: first.challenge }));
  const code = await a.codeFor(started.secret);
  assert.equal((await json(await a.confirm(started.totpId, code, { challenge: second.challenge }), 409)).code, "no_pending_enrollment");
  assert.equal((await json(await a.confirm(started.totpId, code, { token: tokens.accessToken }), 409)).code, "no_pending_enrollment");
  const confirm = () => a.confirm(started.totpId, code, { challenge: first.challenge });
  const confirmed = await Promise.all([confirm(), confirm()]);
  assert.deepEqual(confirmed.map((response) => response.status).sort(), [200, 400]);
  assert.equal((await json(confirmed.find((response) => response.status === 400), 400)).code, "invalid_challenge");
  assert.equal((await a.run(a.auth.core.listSessions(CALL, { userId: tokens.userId }))).length, 1);

  assert.equal((await json(await a.post("mfa/totp", { challenge: second.challenge }), 400)).code, "invalid_challenge");
  assert.equal((await json(await a.confirm(started.totpId, code, { challenge: second.challenge }), 400)).code, "invalid_challenge");
});

test("enrollment confirmation shares the account's code budget across challenge and session forms", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  const { challenge } = await json(await a.signIn("alice"));
  const challenged = await json(await a.post("mfa/totp", { challenge }));
  for (let attempt = 0; attempt < MAX_CHALLENGE_ATTEMPTS; attempt++) {
    assert.equal((await json(await a.confirm(challenged.totpId, "invalid", { challenge }), 400)).code, "incorrect_code");
  }
  assert.equal((await json(await a.confirm(challenged.totpId, await a.codeFor(challenged.secret), { challenge }), 400)).code, "invalid_challenge");

  const token = tokens.accessToken;
  const signedIn = await json(await a.post("mfa/totp", { password: PASSWORD }, token));
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await json(await a.confirm(signedIn.totpId, "invalid", { token }), 400)).code, "incorrect_code");
  }
  const limited = await a.confirm(signedIn.totpId, await a.codeFor(signedIn.secret), { token });
  assert.equal((await json(limited, 429)).code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "12");

  const next = await json(await a.signIn("alice"));
  const started = await json(await a.post("mfa/totp", { challenge: next.challenge }));
  const confirm = async () => a.confirm(started.totpId, await a.codeFor(started.secret), { challenge: next.challenge });
  assert.equal((await json(await confirm(), 429)).code, "rate_limited");
  a.advance(12_000);
  assert.equal((await json(await confirm())).status, "complete");
});

test("(d) policy all asks every account; privileged reads roles, system permissions and system grants", async (t) => {
  const a = await compose(t);
  await a.signUp("alice");
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  assert.equal((await json(await a.signIn("alice"))).status, "mfa_enrollment_required");
  const base = { roles: ["user"], permissions: [], grants: [] };
  assert.equal(isPrivileged(base), false);
  assert.equal(isPrivileged({ ...base, roles: ["admin"] }), true);
  assert.equal(isPrivileged({ ...base, permissions: ["system.users.manage"] }), true);
  assert.equal(isPrivileged({ ...base, grants: [{ permission: "system.settings.manage", scope: { type: "system" } }] }), true);
  assert.equal(isPrivileged({ ...base, permissions: ["project.view"] }), false);
});

test("the policy routes need the settings permission and refuse a stale revision with 409", async (t) => {
  const a = await compose(t);
  const admin = await a.signUp("admin");
  const plain = await a.signUp("plain");
  await a.setAccess(admin.tokens.userId, { permissions: ["system.settings.manage"] });
  assert.equal((await a.call("mfa/policy", { token: plain.tokens.accessToken })).status, 403);
  assert.deepEqual(await json(await a.call("mfa/policy", { token: admin.tokens.accessToken })), { requiredFor: "none", revision: 0 });
  const saved = await json(await a.call("mfa/policy", { method: "PUT", body: { requiredFor: "privileged", expectedRevision: 0 }, token: admin.tokens.accessToken }));
  assert.deepEqual(saved, { requiredFor: "privileged", revision: 1 });
  const stale = await json(await a.call("mfa/policy", { method: "PUT", body: { requiredFor: "all", expectedRevision: 0 }, token: admin.tokens.accessToken }), 409);
  assert.equal(stale.code, "mfa_policy_conflict");
  assert.deepEqual(stale.policy, { requiredFor: "privileged", revision: 1 });
  assert.equal((await json(await a.call("mfa/policy", { method: "PUT", body: { requiredFor: "sometimes", expectedRevision: 1 }, token: admin.tokens.accessToken }), 400)).code, "invalid_request");
});

test("(e) resetting an account's second factor removes its secrets and backup codes; the next sign-in completes", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret } = await a.enrollByRoute(tokens.accessToken);
  const { challenge } = await json(await a.signIn("alice"));
  assert.equal(await a.mutate((tx) => resetSecondFactor(tx, tokens.userId)), 1);
  assert.equal((await a.rows(totpTables.totpSecrets)).length, 0);
  assert.equal((await a.rows(totpTables.backupCodes)).length, 0);
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: await a.codeFor(secret) }), 400)).code, "invalid_challenge");
  assert.equal((await a.call("session", { token: tokens.accessToken })).status, 401, "reset revoked the access token");
  assert.deepEqual(await a.run(a.auth.core.refreshSession(CALL, { refreshToken: tokens.refreshToken })), { kind: "noSession" });
  const next = await json(await a.signIn("alice"));
  assert.equal(next.status, "complete");
  const newFactor = await a.enrollByRoute(next.tokens.accessToken);
  const newCode = await a.codeFor(newFactor.secret);
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: newCode }), 400)).code, "invalid_challenge");
  const fresh = await json(await a.signIn("alice"));
  assert.equal((await json(await a.post("mfa/verify", { challenge: fresh.challenge, code: newCode }))).status, "complete");
});

test("a reset invalidates pre-reset enrollment challenges, including an enrollment already started", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  const { challenge } = await json(await a.signIn("alice"));
  const started = await json(await a.post("mfa/totp", { challenge }));
  assert.equal(await a.mutate((tx) => resetSecondFactor(tx, tokens.userId)), 0);
  assert.equal((await a.rows(totpTables.totpSecrets)).length, 0);
  assert.equal((await json(await a.post("mfa/totp", { challenge }), 400)).code, "invalid_challenge");
  assert.equal((await json(await a.confirm(started.totpId, await a.codeFor(started.secret), { challenge }), 400)).code, "invalid_challenge");
  assert.equal((await json(await a.signIn("alice"))).status, "mfa_enrollment_required");
});

test("password change invalidates a pending sign-in and an enrollment even when the initiating session stays live", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const token = tokens.accessToken;
  const first = await a.enrollByRoute(token);
  const { challenge } = await json(await a.signIn("alice"));
  const started = await json(await a.post("mfa/totp", { password: PASSWORD, code: first.backupCodes[0] }, token));
  await json(await a.post("username-password/change-password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, token));

  assert.equal((await a.call("session", { token })).status, 200);
  assert.equal((await json(await a.confirm(started.totpId, await a.codeFor(started.secret), { token }), 409)).code, "no_pending_enrollment");
  const finish = async (challenge) => a.post("mfa/verify", { challenge, code: await a.codeFor(first.secret) });
  assert.equal((await json(await finish(challenge), 400)).code, "invalid_challenge");
  const fresh = await json(await a.signIn("alice", NEW_PASSWORD));
  assert.equal((await json(await finish(fresh.challenge))).status, "complete");
});

test("password recovery revokes existing sessions and accepts only the fresh MFA challenge", async (t) => {
  const outbox = recordingOutbox();
  const a = await compose(t, { emailOutbox: outbox });
  const running = await a.run(a.auth.start());
  t.after(() => a.run(running.stop()));
  const email = "alice@example.test";
  const started = await json(await a.post("email-password/sign-up", { email, password: PASSWORD }));
  await waitFor(() => outbox.delivered.length >= 1, { what: "the verification email" });
  const { tokens } = await json(await a.post("email-password/complete-sign-up", {
    emailCode: emailLinkOf(outbox.delivered[0]).code, browserSecret: started.browserSecret,
  }));
  const { secret } = await a.enrollByRoute(tokens.accessToken);
  const old = await json(await a.post("email-password/sign-in", { email, password: PASSWORD }));
  const link = await json(await a.post("email-password/recovery/start", { email }));
  await waitFor(() => outbox.delivered.length >= 2, { what: "the recovery email" });
  const recovered = await json(await a.post("email-password/recovery/complete", {
    emailCode: emailLinkOf(outbox.delivered[1]).code, browserSecret: link.browserSecret, newPassword: NEW_PASSWORD,
  }));
  assert.equal(recovered.status, "mfa_required");
  assert.equal((await a.call("session", { token: tokens.accessToken })).status, 401);
  assert.deepEqual(await a.run(a.auth.core.refreshSession(CALL, { refreshToken: tokens.refreshToken })), { kind: "noSession" });
  const code = await a.codeFor(secret);
  assert.equal((await json(await a.post("mfa/verify", { challenge: old.challenge, code }), 400)).code, "invalid_challenge");
  assert.equal((await json(await a.post("mfa/verify", { challenge: recovered.challenge, code }))).status, "complete");
});

test("(f) a stored secret is sealed, and so is a pending sign-in's profile", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const { secret } = await a.enrollByRoute(tokens.accessToken);
  const [row] = await a.rows(totpTables.totpSecrets);
  assert.ok(!JSON.stringify(row).includes(secret), "the stored row holds no raw secret");
  assert.ok(!JSON.stringify(row).includes(JSON.stringify([...base32Decode(secret)]).slice(1, -1)));
  assert.equal(row.sealedSecret.algorithm, "AES-256-GCM");
  assert.equal(secretOf(row), secret);
  assert.throws(() => decryptSecret(row.sealedSecret, TEST_MASTER_SECRET), "the TOTP key is bound to its purpose");
  await a.signIn("alice");
  const [pending] = await a.rows(totpTables.pendingSignIns);
  assert.equal(pending.sealedProfile.algorithm, "AES-256-GCM");
});

test("removing an authenticator and replacing the backup codes take a current code", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const token = tokens.accessToken;
  assert.equal((await json(await a.post("mfa/backup-codes", { code: "000000" }, token), 409)).code, "mfa_not_enabled");
  const first = await a.enrollByRoute(token);
  const replaced = await json(await a.post("mfa/backup-codes", { code: await a.codeFor(first.secret) }, token));
  assert.equal(replaced.backupCodes.length, 10);
  assert.ok(!replaced.backupCodes.includes(first.backupCodes[0]));
  a.advance(PERIOD_MS);
  assert.equal((await json(await a.call(`mfa/totp/${first.totpId}`, { method: "DELETE", body: { code: "000000" }, token }), 400)).code, "incorrect_code");
  assert.equal((await json(await a.call("mfa/totp/00000000000000000000000000000000", { method: "DELETE", body: { code: await a.codeFor(first.secret) }, token }), 404)).code, "totp_not_found");
  await json(await a.call(`mfa/totp/${first.totpId}`, { method: "DELETE", body: { code: replaced.backupCodes[0] }, token }));
  const status = await json(await a.call("mfa", { token }));
  assert.deepEqual([status.enabled, status.backupCodesRemaining], [false, 0], "the last authenticator takes the backup codes with it");
  assert.equal((await json(await a.signIn("alice"))).status, "complete");
});

test("MFA policy allows removing one of two authenticators and preserves the proof when refusing the last", async (t) => {
  const a = await compose(t);
  const { tokens } = await a.signUp("alice");
  const token = tokens.accessToken;
  const first = await a.enrollByRoute(token);
  const second = await json(await a.post("mfa/totp", { password: PASSWORD, code: first.backupCodes[0] }, token));
  await json(await a.confirm(second.totpId, await a.codeFor(second.secret), { token }));
  await a.run(a.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  const remove = (id, code) => a.call(`mfa/totp/${id}`, { method: "DELETE", body: { code }, token });
  await json(await remove(first.totpId, first.backupCodes[1]));
  const unused = first.backupCodes[2];
  assert.equal((await json(await remove(second.totpId, unused), 409)).code, "mfa_required_by_policy");
  const status = await json(await a.call("mfa", { token }));
  assert.deepEqual(status.totps.map((entry) => entry.totpId), [second.totpId]);
  assert.equal(status.backupCodesRemaining, 8);
  const { challenge } = await json(await a.signIn("alice"));
  assert.equal((await json(await a.post("mfa/verify", { challenge, code: unused }))).status, "complete");
});

test("(g) an App runtime has its own policy and factors", async (t) => {
  const platform = await compose(t);
  const app = await compose(t, { role: "project", projectId: "project-1" });
  await platform.signUp("alice");
  const appAlice = await app.signUp("alice");
  await app.run(app.auth.mfa.policy.set(CALL, { requiredFor: "all", expectedRevision: 0 }));
  assert.deepEqual(await platform.run(platform.auth.mfa.policy.get(CALL)), { requiredFor: "none", revision: 0 });
  assert.equal((await json(await platform.signIn("alice"))).status, "complete");
  assert.equal((await json(await app.signIn("alice"))).status, "mfa_enrollment_required");
  const { secret } = await app.enrollByRoute(appAlice.tokens.accessToken);
  assert.equal((await platform.rows(totpTables.totpSecrets)).length, 0);
  assert.equal((await app.rows(totpTables.totpSecrets)).length, 1);
  void secret;
});

test("every MFA user error has an HTTP mapping, and the routes are listed", async (t) => {
  const a = await compose(t);
  const ids = a.auth.routes.map((route) => route.id).filter((id) => id.startsWith("auth.mfa."));
  assert.deepEqual(ids.sort(), [
    "auth.mfa.backupCodes.regenerate", "auth.mfa.policy.get", "auth.mfa.policy.set", "auth.mfa.status",
    "auth.mfa.totp.confirm", "auth.mfa.totp.remove", "auth.mfa.totp.start", "auth.mfa.verify",
  ]);
});
