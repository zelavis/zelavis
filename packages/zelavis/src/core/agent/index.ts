import {
  resolveTrustedEd25519Key,
  type ZelavisHostOperationExecutor,
  type ZelavisHostOperationRequest,
  type ZelavisHostOperationTrustStore,
} from "../deployment/index.js";

/**
 * Platform authority keys an Agent accepts envelopes from. Same structure and
 * rules as the release trust store; a different file with different owners.
 */
export type ZelavisAgentAuthorityTrustStore = ZelavisHostOperationTrustStore;

const AGENT_AUTHORITY_CONTEXT = "zelavis-agent-authority-v2\n";

export type ZelavisAgentOperationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type ZelavisAgentOperationEventType =
  | "submitted"
  | "claimed"
  | "recovered"
  | "succeeded"
  | "failed";

export interface ZelavisAgentIdentity {
  readonly id: string;
  readonly createdAt: string;
}

export interface ZelavisAgentOperationEvent {
  readonly sequence: number;
  readonly type: ZelavisAgentOperationEventType;
  readonly timestamp: string;
  readonly ownerId?: string;
}

export interface ZelavisAgentOperationSummary {
  readonly operationId: string;
  readonly agentId: string;
  readonly operation: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly projectId?: string;
  readonly status: ZelavisAgentOperationStatus;
  readonly attempts: number;
  readonly leaseExpiresAt?: string;
  readonly exitCode?: number;
  /** A manifest-declared JSON result. */
  readonly result?: Readonly<Record<string, unknown>>;
  readonly resultError?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly ZelavisAgentOperationEvent[];
}

export interface ZelavisAgentOperationReader {
  readonly identity: ZelavisAgentIdentity;
  get(operationId: string): Promise<ZelavisAgentOperationSummary | undefined>;
  list(options?: {
    readonly status?: ZelavisAgentOperationStatus;
    readonly limit?: number;
  }): Promise<readonly ZelavisAgentOperationSummary[]>;
}

export interface ZelavisAgentOperationManager extends ZelavisAgentOperationReader {
  submit(request: ZelavisHostOperationRequest): Promise<ZelavisAgentOperationSummary>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}

export interface ZelavisAgentOperationManagerOptions {
  readonly executor: ZelavisHostOperationExecutor;
  readonly concurrency?: number;
  readonly discoveryLimit?: number;
}

export interface ZelavisAgentAuthorityClaims {
  /** The Platform key that signs the envelope; must be in the Agent's trust store. */
  readonly keyId: string;
  readonly agentId: string;
  readonly operationId: string;
  readonly operation: string;
  readonly version: string;
  readonly artifactDigest: string;
  /**
   * SHA-256 of the request's arguments (`hostOperationArgumentsDigest`), so an
   * envelope authorizes exactly one argument set rather than any values the
   * manifest would accept.
   */
  readonly argumentsDigest: string;
  readonly projectId?: string;
  readonly actorId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
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

/** Digest of a host operation's arguments, independent of key order. */
export async function hostOperationArgumentsDigest(
  args: Readonly<Record<string, string>>,
): Promise<string> {
  const canonical = JSON.stringify(
    Object.keys(args).sort().map((name) => [name, args[name]]),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function canonicalAgentClaims(claims: ZelavisAgentAuthorityClaims): string {
  return JSON.stringify([
    claims.keyId,
    claims.agentId,
    claims.operationId,
    claims.operation,
    claims.version,
    claims.artifactDigest,
    claims.argumentsDigest,
    claims.projectId ?? null,
    claims.actorId,
    claims.issuedAt,
    claims.expiresAt,
    claims.nonce,
  ]);
}

function validateAgentAuthorityClaims(claims: ZelavisAgentAuthorityClaims) {
  const boundedId = (value: string, maximum = 256) =>
    typeof value === "string" && value.length > 0 && value.length <= maximum;
  if (
    !boundedId(claims.keyId, 128) ||
    !boundedId(claims.agentId) ||
    !boundedId(claims.operationId, 128) ||
    !boundedId(claims.operation, 128) ||
    !boundedId(claims.version, 64) ||
    !/^[a-f0-9]{64}$/.test(claims.artifactDigest) ||
    !/^[a-f0-9]{64}$/.test(claims.argumentsDigest) ||
    (claims.projectId !== undefined && !boundedId(claims.projectId)) ||
    !boundedId(claims.actorId) ||
    !boundedId(claims.nonce) ||
    !Number.isFinite(claims.issuedAt) ||
    !Number.isFinite(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > 15 * 60_000
  ) {
    throw new TypeError("Agent authority claims are invalid or unbounded.");
  }
}

/**
 * Signs one short-lived, operation-specific Agent authority envelope with the
 * Platform's Ed25519 key. Only the Platform holds the private key; an Agent
 * verifies with the public half, so compromising an Agent does not let it
 * issue authority to itself or any other Agent.
 */
export async function signAgentAuthority(
  privateKey: CryptoKey,
  claims: ZelavisAgentAuthorityClaims,
): Promise<string> {
  validateAgentAuthorityClaims(claims);
  const payload = new TextEncoder().encode(canonicalAgentClaims(claims));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${AGENT_AUTHORITY_CONTEXT}${canonicalAgentClaims(claims)}`),
  );
  return `${base64UrlEncode(payload)}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies signer trust, audience, exact request binding (including
 * arguments), expiry, and optional replay consumption, in that order: a nonce
 * is only consumed by an envelope that is otherwise valid.
 */
export async function verifyAgentAuthority(
  trust: ZelavisAgentAuthorityTrustStore,
  token: string,
  request: ZelavisHostOperationRequest,
  options: {
    readonly audienceAgentId: string;
    readonly now?: number;
    readonly consumeNonce?: (nonce: string, expiresAt: number) => boolean;
  },
): Promise<ZelavisAgentAuthorityClaims | undefined> {
  if (typeof token !== "string" || token.length > 16_384) return undefined;
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;
  let payloadText: string;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  let decoded: unknown;
  try {
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(token.slice(0, separator)));
    signatureBytes = base64UrlDecode(token.slice(separator + 1));
    decoded = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 12) return undefined;
  const [
    keyId,
    agentId,
    operationId,
    operation,
    version,
    artifactDigest,
    argumentsDigest,
    projectId,
    actorId,
    issuedAt,
    expiresAt,
    nonce,
  ] = decoded;
  if (
    typeof keyId !== "string" ||
    typeof agentId !== "string" ||
    typeof operationId !== "string" ||
    typeof operation !== "string" ||
    typeof version !== "string" ||
    typeof artifactDigest !== "string" ||
    typeof argumentsDigest !== "string" ||
    (projectId !== null && typeof projectId !== "string") ||
    typeof actorId !== "string" ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    typeof nonce !== "string"
  ) return undefined;
  const now = options.now ?? Date.now();
  // The key must be trusted now, not merely when the envelope claims it was
  // issued: authority is short-lived, so a closed or revoked key issues none.
  const publicKey = await resolveTrustedEd25519Key(trust, keyId, now);
  if (!publicKey || signatureBytes.byteLength !== 64) return undefined;
  if (!(await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signatureBytes,
    new TextEncoder().encode(`${AGENT_AUTHORITY_CONTEXT}${payloadText}`),
  ))) return undefined;
  if (
    agentId !== options.audienceAgentId ||
    operationId !== request.operationId ||
    operation !== request.operation ||
    version !== request.version ||
    artifactDigest !== request.artifactDigest ||
    argumentsDigest !== await hostOperationArgumentsDigest(request.arguments) ||
    (projectId ?? undefined) !== request.projectId ||
    issuedAt > now + 5_000 ||
    expiresAt <= now ||
    expiresAt - issuedAt > 15 * 60_000
  ) return undefined;
  if (options.consumeNonce && !options.consumeNonce(nonce, expiresAt)) {
    return undefined;
  }
  return {
    keyId,
    agentId,
    operationId,
    operation,
    version,
    artifactDigest,
    argumentsDigest,
    ...(projectId ? { projectId } : {}),
    actorId,
    issuedAt,
    expiresAt,
    nonce,
  };
}

export function createAgentNonceTracker(): (nonce: string, expiresAt: number) => boolean {
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
