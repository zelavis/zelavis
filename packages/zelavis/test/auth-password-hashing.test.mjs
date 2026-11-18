/**
 * Zelavis Auth password hashing: new hashes are PBKDF2 in PHC form; Zelavis's earlier PBKDF2 form and the formats of
 * other systems still verify and are marked for replacement.
 */
import assert from "node:assert/strict";
import { pbkdf2Sync, scryptSync } from "node:crypto";
import test from "node:test";
import { Effect } from "effect";
import { PBKDF2_ITERATIONS, hashPassword, needsRehash, verifyPasswordHash } from "../dist/auth/password/hashing.js";

const run = (effect) => Effect.runPromise(effect);
const url = (buffer) => buffer.toString("base64url");
// Generated with `htpasswd -bnBC 5 "" short` (Apache's bcrypt), as in auth-account-import.test.mjs.
const BCRYPT_SHORT = "$2y$05$guQQF.7Y1briSwnHQRZ4Ou5JPGuMKhbQRR9PjATYyaTkdpfnXdrzq";

test("a new hash is PHC PBKDF2 at 600 000 iterations and verifies only its password", async () => {
  const hash = await run(hashPassword("correct horse battery"));
  assert.match(hash, /^\$pbkdf2-sha256\$i=600000\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.equal(needsRehash(hash), false);
  assert.equal(await run(verifyPasswordHash("correct horse battery", hash)), true);
  assert.equal(await run(verifyPasswordHash("correct horse batterz", hash)), false);
  assert.notEqual(hash, await run(hashPassword("correct horse battery")), "a fresh salt each time");
});

test("a password is NFC-normalized before it is hashed, and a hash of a raw non-NFC password still verifies", async () => {
  const composed = "café-café-café-cafe";
  const decomposed = composed.normalize("NFD");
  assert.equal(await run(verifyPasswordHash(decomposed, await run(hashPassword(composed)))), true);
  // Zelavis's earlier form hashed the raw string.
  const salt = Buffer.from("0123456789abcdef");
  const old = `pbkdf2-sha256$100000$${url(salt)}$${url(pbkdf2Sync(decomposed, salt, 100_000, 32, "sha256"))}`;
  assert.equal(await run(verifyPasswordHash(decomposed, old)), true);
});

test("Zelavis's earlier PBKDF2 form verifies and is marked for replacement", async () => {
  const salt = Buffer.from("fedcba9876543210");
  const old = `pbkdf2-sha256$600000$${url(salt)}$${url(pbkdf2Sync("an old password!!", salt, 600_000, 32, "sha256"))}`;
  assert.equal(await run(verifyPasswordHash("an old password!!", old)), true);
  assert.equal(await run(verifyPasswordHash("an old password!?", old)), false);
  assert.equal(needsRehash(old), true);
});

test("a PHC hash at another iteration count verifies and is marked for replacement", async () => {
  const salt = Buffer.from("0123456789abcdef");
  const phc = `$pbkdf2-sha256$i=100000$${salt.toString("base64").replace(/=+$/, "")}$${pbkdf2Sync("another password", salt, 100_000, 32, "sha256").toString("base64").replace(/=+$/, "")}`;
  assert.equal(await run(verifyPasswordHash("another password", phc)), true);
  assert.equal(needsRehash(phc), true);
});

test("bcrypt and scrypt hashes verify and are marked for replacement", async () => {
  assert.equal(await run(verifyPasswordHash("short", BCRYPT_SHORT)), true);
  assert.equal(await run(verifyPasswordHash("shorT", BCRYPT_SHORT)), false);
  assert.equal(needsRehash(BCRYPT_SHORT), true);
  const salt = Buffer.from("scryptsalt-bytes");
  const scrypt = `scrypt$14$8$1$${url(salt)}$${url(scryptSync("scrypt password!!", salt, 64, { N: 16384, r: 8, p: 1 }))}`;
  assert.equal(await run(verifyPasswordHash("scrypt password!!", scrypt)), true);
  assert.equal(await run(verifyPasswordHash("scrypt password!?", scrypt)), false);
  assert.equal(needsRehash(scrypt), true);
});

test("malformed or out-of-bounds hashes are not a match and are marked for replacement", async () => {
  for (const stored of ["", "plain", "$pbkdf2-sha256$i=5$AAAA$AAAA", "$pbkdf2-sha256$i=600000$$", "pbkdf2-sha256$600000$AAAA", "$2b$10$tooshort"]) {
    assert.equal(await run(verifyPasswordHash("whatever it is", stored)), false, stored);
    assert.equal(needsRehash(stored), true, stored);
  }
  assert.equal(await run(verifyPasswordHash("x".repeat(1025), await run(hashPassword("x".repeat(1024))))), false, "over the length limit");
  assert.equal(await run(verifyPasswordHash("x".repeat(1024), await run(hashPassword("x".repeat(1024))))), true);
});
