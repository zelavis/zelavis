import { AuthValidationError } from "./errors.js";

const DEFAULT_ITERATIONS = 600_000;

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new AuthValidationError("Secure Web Crypto is required for password hashing.");
  }
  return globalThis.crypto;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await cryptoApi().subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(await cryptoApi().subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations },
    key,
    256,
  ));
}

export async function hashPassword(
  password: string,
  options: { iterations?: number } = {},
): Promise<string> {
  if (typeof password !== "string" || password.length < 15) {
    throw new AuthValidationError("Passwords must contain at least 15 characters.");
  }
  if (password.length > 1024) {
    throw new AuthValidationError("Passwords must not exceed 1024 characters.");
  }
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) {
    throw new AuthValidationError("PBKDF2 iterations must be between 100000 and 10000000.");
  }
  const salt = new Uint8Array(16);
  cryptoApi().getRandomValues(salt);
  return `pbkdf2-sha256$${iterations}$${encode(salt)}$${encode(await derive(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  if (typeof password !== "string" || password.length > 1024) return false;
  const [algorithm, iterationsText, saltText, expectedText, extra] = encodedHash.split("$");
  if (algorithm !== "pbkdf2-sha256" || extra !== undefined) return false;
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) return false;
  try {
    const expected = decode(expectedText);
    const actual = await derive(password, decode(saltText), iterations);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index += 1) {
      difference |= actual[index] ^ expected[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}
