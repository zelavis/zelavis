import type {
  ZelavisHostOperationExecutor,
  ZelavisHostOperationRequest,
} from "../deployment/index.js";

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
  readonly agentId: string;
  readonly operationId: string;
  readonly operation: string;
  readonly version: string;
  readonly artifactDigest: string;
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

function canonicalAgentClaims(claims: ZelavisAgentAuthorityClaims): string {
  return JSON.stringify([
    claims.agentId,
    claims.operationId,
    claims.operation,
    claims.version,
    claims.artifactDigest,
    claims.projectId ?? null,
    claims.actorId,
    claims.issuedAt,
    claims.expiresAt,
    claims.nonce,
  ]);
}

async function importAgentSigningKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new TypeError("Agent authority secret must contain at least 32 characters.");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function validateAgentAuthorityClaims(claims: ZelavisAgentAuthorityClaims) {
  const boundedId = (value: string, maximum = 256) =>
    typeof value === "string" && value.length > 0 && value.length <= maximum;
  if (
    !boundedId(claims.agentId) ||
    !boundedId(claims.operationId, 128) ||
    !boundedId(claims.operation, 128) ||
    !boundedId(claims.version, 64) ||
    !/^[a-f0-9]{64}$/.test(claims.artifactDigest) ||
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

/** Signs one short-lived, operation-specific Agent authority envelope. */
export async function signAgentAuthority(
  secret: string,
  claims: ZelavisAgentAuthorityClaims,
): Promise<string> {
  validateAgentAuthorityClaims(claims);
  const payload = canonicalAgentClaims(claims);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importAgentSigningKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${base64UrlEncode(new TextEncoder().encode(payload))}.${base64UrlEncode(
    new Uint8Array(signature),
  )}`;
}

/** Verifies audience, request binding, expiry, and optional replay consumption. */
export async function verifyAgentAuthority(
  secret: string,
  token: string,
  request: ZelavisHostOperationRequest,
  options: {
    readonly audienceAgentId: string;
    readonly now?: number;
    readonly consumeNonce?: (nonce: string, expiresAt: number) => boolean;
  },
): Promise<ZelavisAgentAuthorityClaims | undefined> {
  const separator = token.indexOf(".");
  if (separator <= 0 || separator === token.length - 1) return undefined;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = base64UrlDecode(token.slice(0, separator));
    signatureBytes = base64UrlDecode(token.slice(separator + 1));
  } catch {
    return undefined;
  }
  if (!(await crypto.subtle.verify(
    "HMAC",
    await importAgentSigningKey(secret),
    signatureBytes,
    payloadBytes,
  ))) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return undefined;
  }
  if (!Array.isArray(decoded) || decoded.length !== 10) return undefined;
  const [
    agentId,
    operationId,
    operation,
    version,
    artifactDigest,
    projectId,
    actorId,
    issuedAt,
    expiresAt,
    nonce,
  ] = decoded;
  if (
    typeof agentId !== "string" ||
    typeof operationId !== "string" ||
    typeof operation !== "string" ||
    typeof version !== "string" ||
    typeof artifactDigest !== "string" ||
    (projectId !== null && typeof projectId !== "string") ||
    typeof actorId !== "string" ||
    typeof issuedAt !== "number" ||
    typeof expiresAt !== "number" ||
    typeof nonce !== "string"
  ) return undefined;
  const now = options.now ?? Date.now();
  if (
    agentId !== options.audienceAgentId ||
    operationId !== request.operationId ||
    operation !== request.operation ||
    version !== request.version ||
    artifactDigest !== request.artifactDigest ||
    (projectId ?? undefined) !== request.projectId ||
    issuedAt > now + 5_000 ||
    expiresAt <= now ||
    expiresAt - issuedAt > 15 * 60_000
  ) return undefined;
  if (options.consumeNonce && !options.consumeNonce(nonce, expiresAt)) {
    return undefined;
  }
  return {
    agentId,
    operationId,
    operation,
    version,
    artifactDigest,
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
