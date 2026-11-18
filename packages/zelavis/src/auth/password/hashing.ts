/**
 * Password hashing for Zelavis Auth (Zelavis-own; upstream hashes with argon2id through `password-hash-wasm`).
 *
 * New hashes are PBKDF2-SHA256 at 600 000 iterations in PHC form:
 * `$pbkdf2-sha256$i=600000$<salt>$<hash>`, salt and hash in standard base64 without padding. Verification also
 * accepts Zelavis's earlier `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url) and the formats of other systems
 * (`legacy.ts`), so an imported account signs in with the password it had; `needsRehash` is true for all of them and
 * the sign-in replaces the stored hash with a new PHC one in the transaction that issues the session.
 *
 * Everything here is slow work and runs outside a transaction (overview D5): a transaction body may run again after a
 * conflict, and must never rehash.
 */
import * as Effect from "effect/Effect";
import { integration } from "../../core/runtime/effect-boundary.js";
import { isLegacyPasswordHash, supportsLegacyPasswordHash, verifyLegacyPassword } from "./legacy.js";
import { MAX_PASSWORD_LENGTH, normalizePassword } from "./validation.js";

export const PBKDF2_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const standard = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "");
};

const BASE64_ANY = /^[A-Za-z0-9+/_-]+$/u;

/** Standard or URL-safe base64, padded or not; undefined when it is neither. */
const decode = (value: string): Uint8Array | undefined => {
  if (!BASE64_ANY.test(value)) return undefined;
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  if (base64.length % 4 === 1) return undefined;
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const derive = (password: string, salt: Uint8Array, iterations: number) =>
  Effect.gen(function* () {
    const key = yield* integration(() => crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]));
    return new Uint8Array(yield* integration(() => crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations }, key, HASH_BITS)));
  }).pipe(Effect.orDie);

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

interface Pbkdf2Hash {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly expected: Uint8Array;
  readonly phc: boolean;
}

const PHC = /^\$pbkdf2-sha256\$i=(\d+)\$([^$]+)\$([^$]+)$/u;

const parsePbkdf2 = (stored: string): Pbkdf2Hash | undefined => {
  const phc = PHC.exec(stored);
  const old = phc === null ? stored.split("$") : undefined;
  const fields = phc !== null
    ? ([phc[1]!, phc[2]!, phc[3]!] as const)
    : old !== undefined && old.length === 4 && old[0] === "pbkdf2-sha256"
      ? ([old[1]!, old[2]!, old[3]!] as const)
      : undefined;
  if (fields === undefined) return undefined;
  const iterations = Number(fields[0]);
  if (!Number.isSafeInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return undefined;
  const salt = decode(fields[1]);
  const expected = decode(fields[2]);
  if (salt === undefined || expected === undefined || salt.length === 0 || expected.length !== HASH_BITS / 8) return undefined;
  return { iterations, salt, expected, phc: phc !== null };
};

/** A new PHC hash of `password` (NFC-normalized, as upstream normalizes before hashing). */
export const hashPassword = Effect.fn("auth.password.hash")(function* (password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = yield* derive(normalizePassword(password), salt, PBKDF2_ITERATIONS);
  return `$pbkdf2-sha256$i=${PBKDF2_ITERATIONS}$${standard(salt)}$${standard(hash)}`;
});

const verifyOne = (password: string, stored: string): Effect.Effect<boolean> => {
  if (isLegacyPasswordHash(stored)) return verifyLegacyPassword(password, stored);
  const parsed = parsePbkdf2(stored);
  if (parsed === undefined) return Effect.succeed(false);
  return Effect.map(derive(password, parsed.salt, parsed.iterations), (actual) => equalBytes(actual, parsed.expected));
};

/**
 * Whether `password` matches `stored`. The NFC form is tried first; a hash made elsewhere from a password that was
 * not normalized also matches the raw form, which is tried only when it differs and the first did not match.
 */
export const verifyPasswordHash = Effect.fn("auth.password.verify")(function* (password: string, stored: string) {
  if ([...password].length > MAX_PASSWORD_LENGTH) return false;
  const normalized = normalizePassword(password);
  if (yield* verifyOne(normalized, stored)) return true;
  return normalized === password ? false : yield* verifyOne(password, stored);
});

/** Checks a persisted password's format and work factors before an upgrade carries it forward. */
export const supportsPasswordHash = (stored: string): boolean =>
  parsePbkdf2(stored) !== undefined || supportsLegacyPasswordHash(stored);

/** True for everything but a PHC PBKDF2 hash at the current iteration count. */
export const needsRehash = (stored: string): boolean => {
  const parsed = parsePbkdf2(stored);
  return parsed === undefined || !parsed.phc || parsed.iterations !== PBKDF2_ITERATIONS;
};
