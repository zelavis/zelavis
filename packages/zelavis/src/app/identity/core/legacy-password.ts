/**
 * Verifying password hashes made by other systems, so an imported account signs in with the password it had.
 *
 * Web Crypto has PBKDF2 but neither bcrypt nor scrypt, so both are written here in plain JavaScript over the
 * standard primitives (PBKDF2-HMAC-SHA256 and AES-CTR come from Web Crypto): nothing native, nothing installed,
 * the same on every runtime. They are only ever used to verify; a successful sign-in replaces the hash with
 * Zelavis's own PBKDF2 (`needsRehash`), so each legacy hash is checked at most until its owner next signs in.
 *
 * The formats kept in a credential's `secretHash`:
 * - bcrypt as it is: `$2a$`, `$2b$` or `$2y$` (Supabase, Laravel, Devise, Apache).
 * - `bcrypt-sha256$<bcrypt>`: Django's `bcrypt_sha256`, which hashes the password with SHA-256 first.
 * - `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>`, salt and hash base64url; Django's `scrypt$…` converts to it.
 * - `firebase-scrypt$<memCost>$<rounds>$<saltSeparator>$<signerKey>$<salt>$<hash>`: Firebase Authentication's
 *   modified scrypt, which encrypts the project's signer key with a scrypt-derived key. The signer key is the
 *   source project's, carried per credential until the rehash removes it.
 *
 * Work is bounded (bcrypt cost at most 14, scrypt at most 64 MiB) and yields to the scheduler while it runs, so a
 * sign-in against a legacy hash never holds the event loop for its whole duration.
 */
import { Effect } from "effect";

const BCRYPT_ALPHABET = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BCRYPT = /^\$2[aby]\$(\d{2})\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/u;
const BCRYPT_MAX_COST = 14;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const subtle = () => globalThis.crypto.subtle;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
};

/** Standard base64 (with `+`, `/` and padding), as Firebase and Django export it. */
export const fromBase64 = (value: string): Uint8Array | undefined =>
  /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 === 0
    ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    : undefined;

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
};

// ---------------------------------------------------------------------------------------------------------------
// bcrypt

/**
 * Blowfish's initial state: the fractional part of pi, 18 P-array words then four 256-word S-boxes.
 *
 * Computed once from Machin's formula in BigInt fixed point rather than written out as 1042 constants, and checked
 * against the first and last published words so a mistake here can never verify a wrong password.
 */
let blowfishInit: { readonly p: Uint32Array; readonly s: Uint32Array } | undefined;
const blowfishState = () => {
  if (blowfishInit !== undefined) return blowfishInit;
  // BigInt() rather than literals: the package is also compiled for targets before ES2020.
  const [zero, one1, two, three, five, sixteen, four, sixtyFour, mask, twoThirtyNine] =
    [0, 1, 2, 3, 5, 16, 4, 64, 0xffffffff, 239].map((value) => BigInt(value)) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const words = 18 + 1024;
  const bits = BigInt(words * 32 + 64);
  const one = one1 << bits;
  const arctanInverse = (x: bigint) => {
    let power = one / x;
    let sum = power;
    const square = x * x;
    for (let k = one1; power !== zero; k += one1) {
      power /= square;
      const term = power / (two * k + one1);
      sum = k % two === one1 ? sum - term : sum + term;
    }
    return sum;
  };
  const pi = sixteen * arctanInverse(five) - four * arctanInverse(twoThirtyNine);
  const fraction = (pi - three * one) >> sixtyFour;
  const all = new Uint32Array(words);
  for (let index = 0; index < words; index += 1) {
    all[index] = Number((fraction >> BigInt((words - index - 1) * 32)) & mask);
  }
  if (all[0] !== 0x243f6a88 || all[17] !== 0x8979fb1b || all[18] !== 0xd1310ba6 || all[words - 1] !== 0x3ac372e6) {
    throw new Error("Blowfish's initial state did not match its published constants.");
  }
  blowfishInit = { p: all.slice(0, 18), s: all.slice(18) };
  return blowfishInit;
};

const bcryptDecode = (text: string, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let bits = 0;
  let buffer = 0;
  let at = 0;
  for (const character of text) {
    buffer = (buffer << 6) | BCRYPT_ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (at < length) bytes[at++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
};

const bcryptEncode = (bytes: Uint8Array): string => {
  let text = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text += BCRYPT_ALPHABET[(buffer >> bits) & 0x3f];
    }
  }
  if (bits > 0) text += BCRYPT_ALPHABET[(buffer << (6 - bits)) & 0x3f];
  return text;
};

const bcryptHash = (password: Uint8Array, cost: number, salt: Uint8Array) => Effect.gen(function* () {
  const init = blowfishState();
  const p = init.p.slice();
  const s = init.s.slice();
  // The key is the password's bytes with a terminating zero, at most 72 bytes, used cyclically.
  const key = new Uint8Array(Math.min(password.length + 1, 72));
  key.set(password.subarray(0, key.length));
  let lr = new Uint32Array(2);
  const encipher = (block: Uint32Array) => {
    let left = block[0]!;
    let right = block[1]!;
    left ^= p[0]!;
    for (let round = 1; round <= 16; round += 2) {
      right ^= (((s[left >>> 24]! + s[256 | ((left >>> 16) & 0xff)]!) ^ s[512 | ((left >>> 8) & 0xff)]!) + s[768 | (left & 0xff)]!) ^ p[round]!;
      left ^= (((s[right >>> 24]! + s[256 | ((right >>> 16) & 0xff)]!) ^ s[512 | ((right >>> 8) & 0xff)]!) + s[768 | (right & 0xff)]!) ^ p[round + 1]!;
    }
    block[0] = right ^ p[17]!;
    block[1] = left;
  };
  const streamWord = (data: Uint8Array, offset: { at: number }) => {
    let word = 0;
    for (let index = 0; index < 4; index += 1) {
      word = (word << 8) | data[offset.at]!;
      offset.at = (offset.at + 1) % data.length;
    }
    return word >>> 0;
  };
  const expand = (data: Uint8Array, mix: Uint8Array | undefined) => {
    const keyOffset = { at: 0 };
    for (let index = 0; index < 18; index += 1) p[index] = p[index]! ^ streamWord(data, keyOffset);
    const mixOffset = { at: 0 };
    lr = new Uint32Array(2);
    const fill = (target: Uint32Array, length: number) => {
      for (let index = 0; index < length; index += 2) {
        if (mix !== undefined) {
          lr[0] = lr[0]! ^ streamWord(mix, mixOffset);
          lr[1] = lr[1]! ^ streamWord(mix, mixOffset);
        }
        encipher(lr);
        target[index] = lr[0]!;
        target[index + 1] = lr[1]!;
      }
    };
    fill(p, 18);
    fill(s, 1024);
  };
  expand(key, salt);
  const rounds = 2 ** cost;
  for (let round = 0; round < rounds; round += 1) {
    expand(key, undefined);
    expand(salt, undefined);
    if ((round & 15) === 15) yield* Effect.yieldNow;
  }
  const text = new TextEncoder().encode("OrpheanBeholderScryDoubt");
  const view = new DataView(text.buffer);
  const blocks = Uint32Array.from({ length: 6 }, (_, index) => view.getUint32(index * 4));
  for (let pass = 0; pass < 64; pass += 1) {
    for (let index = 0; index < 6; index += 2) {
      const pair = blocks.subarray(index, index + 2);
      encipher(pair);
    }
  }
  const out = new Uint8Array(24);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 6; index += 1) outView.setUint32(index * 4, blocks[index]!);
  return out.subarray(0, 23);
});

const verifyBcrypt = (password: Uint8Array, hash: string) => Effect.gen(function* () {
  const match = BCRYPT.exec(hash);
  if (match === null) return false;
  const cost = Number(match[1]);
  if (cost < 4 || cost > BCRYPT_MAX_COST) return false;
  const actual = yield* bcryptHash(password, cost, bcryptDecode(match[2]!, 16));
  return equalBytes(new TextEncoder().encode(bcryptEncode(actual)), new TextEncoder().encode(match[3]!));
});

// ---------------------------------------------------------------------------------------------------------------
// scrypt (RFC 7914)

const pbkdf2Sha256 = (password: Uint8Array, salt: Uint8Array, bytes: number) => Effect.gen(function* () {
  const key = yield* Effect.promise(() => subtle().importKey("raw", Uint8Array.from(password), "PBKDF2", false, ["deriveBits"]));
  return new Uint8Array(yield* Effect.promise(() => subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations: 1 }, key, bytes * 8)));
});

const rotate = (value: number, by: number) => (value << by) | (value >>> (32 - by));

/** Salsa20/8 over one 16-word block, in place. */
const salsa208 = (block: Uint32Array) => {
  let x0 = block[0]!, x1 = block[1]!, x2 = block[2]!, x3 = block[3]!, x4 = block[4]!, x5 = block[5]!, x6 = block[6]!, x7 = block[7]!;
  let x8 = block[8]!, x9 = block[9]!, x10 = block[10]!, x11 = block[11]!, x12 = block[12]!, x13 = block[13]!, x14 = block[14]!, x15 = block[15]!;
  for (let round = 0; round < 8; round += 2) {
    x4 ^= rotate(x0 + x12, 7); x8 ^= rotate(x4 + x0, 9); x12 ^= rotate(x8 + x4, 13); x0 ^= rotate(x12 + x8, 18);
    x9 ^= rotate(x5 + x1, 7); x13 ^= rotate(x9 + x5, 9); x1 ^= rotate(x13 + x9, 13); x5 ^= rotate(x1 + x13, 18);
    x14 ^= rotate(x10 + x6, 7); x2 ^= rotate(x14 + x10, 9); x6 ^= rotate(x2 + x14, 13); x10 ^= rotate(x6 + x2, 18);
    x3 ^= rotate(x15 + x11, 7); x7 ^= rotate(x3 + x15, 9); x11 ^= rotate(x7 + x3, 13); x15 ^= rotate(x11 + x7, 18);
    x1 ^= rotate(x0 + x3, 7); x2 ^= rotate(x1 + x0, 9); x3 ^= rotate(x2 + x1, 13); x0 ^= rotate(x3 + x2, 18);
    x6 ^= rotate(x5 + x4, 7); x7 ^= rotate(x6 + x5, 9); x4 ^= rotate(x7 + x6, 13); x5 ^= rotate(x4 + x7, 18);
    x11 ^= rotate(x10 + x9, 7); x8 ^= rotate(x11 + x10, 9); x9 ^= rotate(x8 + x11, 13); x10 ^= rotate(x9 + x8, 18);
    x12 ^= rotate(x15 + x14, 7); x13 ^= rotate(x12 + x15, 9); x14 ^= rotate(x13 + x12, 13); x15 ^= rotate(x14 + x13, 18);
  }
  block[0] = block[0]! + x0; block[1] = block[1]! + x1; block[2] = block[2]! + x2; block[3] = block[3]! + x3;
  block[4] = block[4]! + x4; block[5] = block[5]! + x5; block[6] = block[6]! + x6; block[7] = block[7]! + x7;
  block[8] = block[8]! + x8; block[9] = block[9]! + x9; block[10] = block[10]! + x10; block[11] = block[11]! + x11;
  block[12] = block[12]! + x12; block[13] = block[13]! + x13; block[14] = block[14]! + x14; block[15] = block[15]! + x15;
};

/** BlockMix: `input` (2r blocks of 16 words) into `output`, using `x` (16 words) as scratch. */
const blockMix = (input: Uint32Array, output: Uint32Array, r: number, x: Uint32Array) => {
  x.set(input.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let index = 0; index < 2 * r; index += 1) {
    for (let word = 0; word < 16; word += 1) x[word] = x[word]! ^ input[index * 16 + word]!;
    salsa208(x);
    // Even blocks to the first half, odd blocks to the second.
    output.set(x, ((index & 1) * r + (index >> 1)) * 16);
  }
};

const scrypt = (password: Uint8Array, salt: Uint8Array, n: number, r: number, p: number, length: number) => Effect.gen(function* () {
  const words = 32 * r;
  const b = yield* pbkdf2Sha256(password, salt, p * 128 * r);
  const bView = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const v = new Uint32Array(words * n);
  const x = new Uint32Array(words);
  const y = new Uint32Array(words);
  const scratch = new Uint32Array(16);
  for (let part = 0; part < p; part += 1) {
    const offset = part * 128 * r;
    for (let word = 0; word < words; word += 1) x[word] = bView.getUint32(offset + word * 4, true);
    for (let index = 0; index < n; index += 1) {
      v.set(x, index * words);
      blockMix(x, y, r, scratch);
      x.set(y);
      if ((index & 1023) === 1023) yield* Effect.yieldNow;
    }
    for (let index = 0; index < n; index += 1) {
      const j = (x[(2 * r - 1) * 16]! >>> 0) & (n - 1);
      for (let word = 0; word < words; word += 1) x[word] = x[word]! ^ v[j * words + word]!;
      blockMix(x, y, r, scratch);
      x.set(y);
      if ((index & 1023) === 1023) yield* Effect.yieldNow;
    }
    for (let word = 0; word < words; word += 1) bView.setUint32(offset + word * 4, x[word]!, true);
  }
  return yield* pbkdf2Sha256(password, b, length);
});

const scryptAllowed = (n: number, r: number, p: number) =>
  Number.isSafeInteger(n) && n >= 2 && (n & (n - 1)) === 0 &&
  Number.isSafeInteger(r) && r >= 1 && r <= 32 && Number.isSafeInteger(p) && p >= 1 && p <= 16 &&
  128 * r * n <= SCRYPT_MAX_MEMORY;

const verifyScrypt = (password: Uint8Array, hash: string) => Effect.gen(function* () {
  const parts = hash.split("$");
  if (parts.length !== 6) return false;
  const [, logText, rText, pText, saltText, expectedText] = parts as [string, string, string, string, string, string];
  const n = 2 ** Number(logText);
  const r = Number(rText);
  const p = Number(pText);
  if (!scryptAllowed(n, r, p) || !BASE64URL.test(saltText) || !BASE64URL.test(expectedText)) return false;
  const expected = fromBase64Url(expectedText);
  if (expected.length < 16 || expected.length > 128) return false;
  return equalBytes(yield* scrypt(password, fromBase64Url(saltText), n, r, p, expected.length), expected);
});

// ---------------------------------------------------------------------------------------------------------------
// Firebase's modified scrypt

const firebaseHash = (password: Uint8Array, salt: Uint8Array, separator: Uint8Array, signerKey: Uint8Array, memCost: number, rounds: number) =>
  Effect.gen(function* () {
    const derived = yield* scrypt(password, Uint8Array.from([...salt, ...separator]), 2 ** memCost, rounds, 1, 64);
    const key = yield* Effect.promise(() => subtle().importKey("raw", derived.slice(0, 32), "AES-CTR", false, ["encrypt"]));
    return new Uint8Array(yield* Effect.promise(() => subtle().encrypt({ name: "AES-CTR", counter: new Uint8Array(16), length: 128 }, key, Uint8Array.from(signerKey))));
  });

const verifyFirebase = (password: Uint8Array, hash: string) => Effect.gen(function* () {
  const parts = hash.split("$");
  if (parts.length !== 7) return false;
  const [, memText, roundsText, separator, signerKey, salt, expected] = parts as [string, string, string, string, string, string, string];
  const memCost = Number(memText);
  const rounds = Number(roundsText);
  if (!Number.isSafeInteger(memCost) || memCost < 1 || !scryptAllowed(2 ** memCost, rounds, 1)) return false;
  if (![signerKey, salt, expected].every((part) => BASE64URL.test(part)) || !(separator === "" || BASE64URL.test(separator))) return false;
  const actual = yield* firebaseHash(password, fromBase64Url(salt), separator === "" ? new Uint8Array() : fromBase64Url(separator), fromBase64Url(signerKey), memCost, rounds);
  return equalBytes(actual, fromBase64Url(expected));
});

// ---------------------------------------------------------------------------------------------------------------

/** Whether `hash` is one of the formats above (and so is verified here, then replaced). */
export const isLegacyPasswordHash = (hash: string) =>
  BCRYPT.test(hash) || hash.startsWith("bcrypt-sha256$") || hash.startsWith("scrypt$") || hash.startsWith("firebase-scrypt$");

/** Verify `password` against a legacy hash; any malformed or out-of-bounds hash is simply not a match. */
export const verifyLegacyPassword = (password: string, hash: string): Effect.Effect<boolean> => {
  const bytes = new TextEncoder().encode(password);
  const check: Effect.Effect<boolean> = BCRYPT.test(hash)
    ? verifyBcrypt(bytes, hash)
    : hash.startsWith("bcrypt-sha256$")
      ? Effect.flatMap(Effect.promise(() => subtle().digest("SHA-256", bytes)), (digest) =>
        verifyBcrypt(new TextEncoder().encode([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")), hash.slice("bcrypt-sha256$".length)))
      : hash.startsWith("scrypt$")
        ? verifyScrypt(bytes, hash)
        : hash.startsWith("firebase-scrypt$")
          ? verifyFirebase(bytes, hash)
          : Effect.succeed(false);
  return check.pipe(Effect.catchDefect(() => Effect.succeed(false)));
};

/** Firebase Authentication's hash parameters, from the project's console (Authentication → Password hash parameters). */
export interface FirebaseHashConfig {
  readonly algorithm: "firebase-scrypt";
  /** base64, as the console shows it. */
  readonly signerKey: string;
  /** base64, as the console shows it. */
  readonly saltSeparator: string;
  readonly rounds: number;
  readonly memCost: number;
}

/**
 * The stored form of a hash exported by another system, or `undefined` when it cannot be verified here.
 *
 * Firebase exports a hash and its salt separately, both base64, and needs the project's `hashConfig`.
 */
export const legacyPasswordHash = (hash: string, options: { readonly salt?: string; readonly hashConfig?: FirebaseHashConfig } = {}): string | undefined => {
  const bcrypt = BCRYPT.exec(hash);
  if (bcrypt !== null) return Number(bcrypt[1]) >= 4 && Number(bcrypt[1]) <= BCRYPT_MAX_COST ? hash : undefined;
  if (hash.startsWith("bcrypt_sha256$")) {
    const inner = hash.slice("bcrypt_sha256$".length);
    return legacyPasswordHash(inner) === inner ? `bcrypt-sha256$${inner}` : undefined;
  }
  if (hash.startsWith("scrypt$")) {
    const parts = hash.split("$");
    // Django: scrypt$<n>$<salt>$<r>$<p>$<base64 hash>, the salt used as its UTF-8 bytes.
    if (parts.length === 6 && /^\d+$/u.test(parts[1]!) && /^\d+$/u.test(parts[3]!) && /^\d+$/u.test(parts[4]!)) {
      const n = Number(parts[1]);
      const r = Number(parts[3]);
      const p = Number(parts[4]);
      const digest = fromBase64(parts[5]!);
      if (!scryptAllowed(n, r, p) || digest === undefined || digest.length < 16 || digest.length > 128 || parts[2] === "") return undefined;
      return `scrypt$${Math.log2(n)}$${r}$${p}$${toBase64Url(new TextEncoder().encode(parts[2]!))}$${toBase64Url(digest)}`;
    }
    return undefined;
  }
  const config = options.hashConfig;
  if (config !== undefined && config.algorithm === "firebase-scrypt") {
    const digest = fromBase64(hash);
    const salt = fromBase64(options.salt ?? "");
    const signerKey = fromBase64(config.signerKey);
    const separator = fromBase64(config.saltSeparator);
    if (digest === undefined || salt === undefined || salt.length === 0 || signerKey === undefined || signerKey.length === 0 || signerKey.length > 256 || separator === undefined) return undefined;
    if (!Number.isSafeInteger(config.memCost) || config.memCost < 1 || !scryptAllowed(2 ** config.memCost, config.rounds, 1)) return undefined;
    return `firebase-scrypt$${config.memCost}$${config.rounds}$${toBase64Url(separator)}$${toBase64Url(signerKey)}$${toBase64Url(salt)}$${toBase64Url(digest)}`;
  }
  return undefined;
};
