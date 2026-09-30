import { parseAllowlist } from "./parse.js";
import {
  ALLOWLIST_MAX_BYTES,
  ALLOWLIST_SIGNING_CONTEXT,
  type Allowlist,
  type AllowlistEnvelope,
} from "./types.js";

export type AllowlistKeyResolver = (keyId: string) => CryptoKey | undefined | Promise<CryptoKey | undefined>;

export type AllowlistVerification =
  | { readonly ok: true; readonly allowlist: Allowlist; readonly keyId: string }
  | { readonly ok: false; readonly reason: string };

const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError("Not base64url.");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Signs an allow-list for publication. Used by release tooling and tests. */
export async function signAllowlist(input: {
  readonly privateKey: CryptoKey;
  readonly keyId: string;
  readonly allowlist: Allowlist;
}): Promise<AllowlistEnvelope> {
  // Validated before signing so a malformed list is never published.
  parseAllowlist(input.allowlist);
  const payload = encode(encoder.encode(JSON.stringify(input.allowlist)));
  if (payload.length > ALLOWLIST_MAX_BYTES) throw new RangeError("The allow-list is too large.");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    encoder.encode(`${ALLOWLIST_SIGNING_CONTEXT}${payload}`),
  );
  return { keyId: input.keyId, payload, signature: encode(new Uint8Array(signature)) };
}

/**
 * Checks an envelope: it is well formed, it was signed by a key this
 * installation trusts, and what it carries is a valid allow-list. Never throws;
 * the reason a list was refused is data.
 */
export async function verifyAllowlistEnvelope(
  value: unknown,
  options: { readonly resolveKey: AllowlistKeyResolver },
): Promise<AllowlistVerification> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: "The allow-list envelope is not an object." };
    }
    const { keyId, payload, signature } = value as Partial<AllowlistEnvelope>;
    if (typeof keyId !== "string" || !keyId || keyId.length > 128 ||
        typeof payload !== "string" || typeof signature !== "string") {
      return { ok: false, reason: "The allow-list envelope is missing its key, payload or signature." };
    }
    if (payload.length > ALLOWLIST_MAX_BYTES) {
      return { ok: false, reason: "The allow-list is larger than the allowed size." };
    }
    const key = await options.resolveKey(keyId);
    if (!key) return { ok: false, reason: `The allow-list is signed by an unknown key "${keyId}".` };
    const signatureBytes = decode(signature);
    if (signatureBytes.byteLength !== 64 ||
        !(await crypto.subtle.verify("Ed25519", key, signatureBytes,
          encoder.encode(`${ALLOWLIST_SIGNING_CONTEXT}${payload}`)))) {
      return { ok: false, reason: "The allow-list signature does not verify." };
    }
    const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(payload)));
    return { ok: true, allowlist: parseAllowlist(json), keyId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The allow-list could not be read." };
  }
}
