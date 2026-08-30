/**
 * Signed authority envelope for the Project Gateway.
 *
 * The Platform proxies requests into a Project runtime that listens on
 * loopback. The runtime therefore cannot trust plain request headers to say who
 * the caller is: any local process able to reach that port could assert the
 * same headers. Binding to `127.0.0.1` is not authentication.
 *
 * The Gateway instead signs a short-lived envelope with a secret generated per
 * runtime and delivered to the child out of band. The child verifies the
 * signature, audience, and expiry before it will build a principal, and the
 * envelope carries the caller's *actual* Project-scoped permissions rather than
 * a wildcard, so proxying cannot amplify authority.
 *
 * This is the local-driver stand-in for the Agent channel described in
 * `TODO.md`. It is deliberately narrow: one audience, one Project, short expiry,
 * single-use nonce.
 */

export const ZELAVIS_GATEWAY_AUTHORITY_HEADER = "x-zelavis-authority";

/** How long a signed envelope stays valid. Requests are loopback and immediate. */
export const ZELAVIS_GATEWAY_AUTHORITY_TTL_MS = 30_000;

export interface ZelavisGatewayAuthorityClaims {
  /** The Project this envelope authorizes, and the only audience that accepts it. */
  readonly projectId: string;
  /** Fabric placement identity, carried through for auditing and future fencing. */
  readonly scopeId: string;
  readonly generation: number;
  readonly runtimeNodeId: string;
  /** The caller's identity, for attribution inside the Project runtime. */
  readonly subject: string;
  readonly subjectType: string;
  /** Permissions the caller actually holds for this Project. Never a wildcard. */
  readonly permissions: readonly string[];
  /** Milliseconds since the epoch after which this envelope is refused. */
  readonly expiresAt: number;
  /** Single-use value so a captured envelope cannot be replayed inside its window. */
  readonly nonce: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Serializes claims deterministically so both sides sign identical bytes.
 * Property order is fixed here rather than inherited from object construction.
 */
function canonicalClaims(claims: ZelavisGatewayAuthorityClaims): string {
  return JSON.stringify([
    claims.projectId,
    claims.scopeId,
    claims.generation,
    claims.runtimeNodeId,
    claims.subject,
    claims.subjectType,
    [...claims.permissions],
    claims.expiresAt,
    claims.nonce,
  ]);
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Signs claims into a `payload.signature` token. */
export async function signGatewayAuthority(
  secret: string,
  claims: ZelavisGatewayAuthorityClaims,
): Promise<string> {
  const payload = canonicalClaims(claims);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${base64UrlEncode(
    new Uint8Array(signature),
  )}`;
}

export interface VerifyGatewayAuthorityOptions {
  /** Only envelopes issued for this Project are accepted. */
  readonly audienceProjectId: string;
  readonly now?: number;
  /** Rejects a nonce that has already been presented. */
  readonly consumeNonce?: (nonce: string, expiresAt: number) => boolean;
}

/**
 * Verifies a signed envelope. Returns the claims, or `undefined` for any
 * failure — a malformed token, a bad signature, the wrong Project, an expired
 * envelope, or a replayed nonce are all simply "not authorized".
 */
export async function verifyGatewayAuthority(
  secret: string,
  token: string,
  options: VerifyGatewayAuthorityOptions,
): Promise<ZelavisGatewayAuthorityClaims | undefined> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;

  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);

  let payloadBytes: Uint8Array<ArrayBuffer>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = base64UrlDecode(payloadPart);
    signatureBytes = base64UrlDecode(signaturePart);
  } catch {
    return undefined;
  }

  // `crypto.subtle.verify` is constant-time with respect to the signature.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importSigningKey(secret),
    signatureBytes,
    payloadBytes,
  );
  if (!valid) return undefined;

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 9) return undefined;

  const [
    projectId,
    scopeId,
    generation,
    runtimeNodeId,
    subject,
    subjectType,
    permissions,
    expiresAt,
    nonce,
  ] = decoded;

  if (
    typeof projectId !== "string" ||
    typeof scopeId !== "string" ||
    typeof generation !== "number" ||
    typeof runtimeNodeId !== "string" ||
    typeof subject !== "string" ||
    typeof subjectType !== "string" ||
    !Array.isArray(permissions) ||
    permissions.some((entry) => typeof entry !== "string") ||
    typeof expiresAt !== "number" ||
    typeof nonce !== "string"
  ) {
    return undefined;
  }

  // A signed envelope is still only valid for the Project it names.
  if (projectId !== options.audienceProjectId) return undefined;

  const now = options.now ?? Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  // Refuse an implausibly long window even if it verifies.
  if (expiresAt - now > ZELAVIS_GATEWAY_AUTHORITY_TTL_MS * 2) return undefined;

  // A wildcard must never arrive over this channel; the Gateway forwards the
  // caller's concrete Project permissions.
  if (permissions.includes("*")) return undefined;

  if (options.consumeNonce && !options.consumeNonce(nonce, expiresAt)) {
    return undefined;
  }

  return {
    projectId,
    scopeId,
    generation,
    runtimeNodeId,
    subject,
    subjectType,
    permissions: permissions as readonly string[],
    expiresAt,
    nonce,
  };
}

/**
 * Bounded single-use nonce tracker for one Project runtime.
 *
 * Entries are only retained for the envelope lifetime, so the set stays small
 * without needing eviction policy tuning.
 */
export function createGatewayNonceTracker(): (
  nonce: string,
  expiresAt: number,
) => boolean {
  const seen = new Map<string, number>();
  return (nonce, expiresAt) => {
    const now = Date.now();
    for (const [value, expiry] of seen) {
      if (expiry <= now) seen.delete(value);
    }
    if (seen.has(nonce)) return false;
    seen.set(nonce, expiresAt);
    return true;
  };
}

/** Generates a per-runtime signing secret. */
export function createGatewayAuthoritySecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Generates a single-use envelope nonce. */
export function createGatewayAuthorityNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
