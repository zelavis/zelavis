import { Data, Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";

/**
 * Node enrollment authority and runtime node registry (internal).
 *
 * Design and threat model: `.agents/references/node-enrollment-design.md`.
 *
 * Authority and invariants:
 * - The authority to enroll is the authority to receive Project workloads, so a
 *   credential is single-use, short-lived and bound to one node id. Only its
 *   SHA-256 hash is stored; the plaintext is returned once, at mint.
 * - Every state change is a System Store `setIfAbsent` or `compareAndSet`
 *   against the exact observed record. The token is consumed before any
 *   registration effect, so two concurrent enrollments cannot both win.
 * - A repeat enrollment with the same certificate, inside the token's expiry,
 *   completes a half-finished one (a crash after consume). A different
 *   certificate is refused, so a stolen token cannot be replayed with another
 *   identity once the real machine has enrolled.
 * - Refusals are one opaque `refused` code to the caller. The specific reason is
 *   carried for audit only and must never reach an unauthenticated client.
 * - A revoked node stays as a tombstone, so its certificate no longer matches a
 *   destination and its id is not silently reused.
 * - Growth is bounded: every retry loop, every page and every field has a limit.
 * - This is internal. Nothing here is a public SDK, HTTP or CLI capability yet.
 */

export const NODE_ENROLLMENT_NAMESPACE = "fabric.node-enrollment.v1";
export const NODE_REGISTRY_NAMESPACE = "fabric.nodes.v1";

const NODE_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TOKEN_BYTES = 32;
const TOKEN_TEXT = /^[A-Za-z0-9_-]{43}$/;
const MAX_ATTEMPTS = 8;
const MAX_CERTIFICATE_CHARS = 8 * 1024;
const MIN_CERTIFICATE_DER_BYTES = 64;
const MAX_ADDRESS_CHARS = 64;
const MAX_PRUNE = 500;
const MAX_PRUNE_SCAN = 2_000;
const PRUNE_PAGE = 100;

export const ENROLLMENT_TTL_MS = {
  /** A machine the Platform creates boots within minutes. */
  cloud: 15 * 60_000,
  /** An operator copies a command to their own server. */
  operator: 60 * 60_000,
} as const;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export type EnrollmentOrigin = keyof typeof ENROLLMENT_TTL_MS;

export type NodeEnrollmentCode =
  | "invalid-request"
  | "node-exists"
  | "enrollment-pending"
  | "refused"
  | "contention";

/** Why a `refused` enrollment was refused. For audit; never shown to the caller. */
export type NodeEnrollmentReason =
  | "unknown-node"
  | "bad-token"
  | "expired"
  | "already-consumed"
  | "source-mismatch"
  | "node-registered"
  | "node-revoked";

export class NodeEnrollmentError extends Data.TaggedError("NodeEnrollmentError")<{
  readonly code: NodeEnrollmentCode;
  readonly message: string;
  readonly reason?: NodeEnrollmentReason;
}> {}

interface EnrollmentRecord {
  readonly v: 1;
  readonly nodeId: string;
  readonly origin: EnrollmentOrigin;
  readonly tokenHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly expectedAddress?: string;
  readonly state: "unused" | "consumed";
  readonly consumedAt?: number;
  readonly certSha256?: string;
}

export interface NodeRecord {
  readonly v: 1;
  readonly nodeId: string;
  readonly agentId: string;
  readonly url: string;
  /** The Agent's certificate, pinned as the CA for this destination. */
  readonly caPem: string;
  readonly certSha256: string;
  readonly enrolledAt: number;
  readonly state: "active" | "revoked";
  readonly revokedAt?: number;
}

/** An enrollment as an operator may see it: never the token or its hash. */
export interface EnrollmentSummary {
  readonly nodeId: string;
  readonly origin: EnrollmentOrigin;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "unused" | "consumed";
}

export interface NodeDestination {
  readonly url: string;
  readonly caPem: string;
  readonly agentId: string;
}

export interface MintEnrollmentInput {
  readonly nodeId: string;
  readonly origin: EnrollmentOrigin;
  readonly ttlMs?: number;
  /** The address the cloud reports for the machine, when it is known. */
  readonly expectedAddress?: string;
  /**
   * Replace an unused enrollment. Only valid when nothing can hold the old
   * token, for example the machine was never created.
   */
  readonly replace?: boolean;
}

export interface MintedEnrollment {
  readonly nodeId: string;
  /** Shown once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: number;
}

export interface CompleteEnrollmentInput {
  readonly nodeId: string;
  readonly token: string;
  readonly certPem: string;
  /** The Agent's HTTPS endpoint: origin only. */
  readonly url: string;
  /** The address the request came from, only when the connection was direct. */
  readonly sourceAddress?: string;
}

export interface CompletedEnrollment {
  readonly node: NodeRecord;
  /** True when this finished an enrollment whose token was already consumed. */
  readonly resumed: boolean;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (data: Uint8Array<ArrayBuffer> | string) =>
  integration(() => crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data))
    .pipe(Effect.map((digest) => hex(new Uint8Array(digest))));

/** Compare two equal-purpose hex digests without an early exit. */
function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const agentIdFor = (nodeId: string): string => `agent-${nodeId}`;

const refuse = (reason: NodeEnrollmentReason) =>
  new NodeEnrollmentError({ code: "refused", message: "Enrollment refused.", reason });
const invalid = (message: string) => new NodeEnrollmentError({ code: "invalid-request", message });

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isEnrollmentRecord = (value: unknown): value is EnrollmentRecord =>
  isObject(value) && value.v === 1 && typeof value.nodeId === "string" &&
  (value.origin === "cloud" || value.origin === "operator") &&
  typeof value.tokenHash === "string" && Number.isFinite(value.createdAt) &&
  Number.isFinite(value.expiresAt) && (value.state === "unused" || value.state === "consumed");

const isNodeRecord = (value: unknown): value is NodeRecord =>
  isObject(value) && value.v === 1 && typeof value.nodeId === "string" &&
  typeof value.agentId === "string" && typeof value.url === "string" &&
  typeof value.caPem === "string" && typeof value.certSha256 === "string" &&
  (value.state === "active" || value.state === "revoked");

/** Origin only, over HTTPS, with nothing that could redirect or smuggle credentials. */
function validateAgentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("The Agent url is not a valid URL.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw invalid("The Agent url must be an https origin.");
  }
  return url.origin;
}

const PEM = /^-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----\s*$/;

/** One certificate, well-formed enough to fingerprint. TLS validates the rest when it is used. */
function parseCertificate(pem: string): { readonly pem: string; readonly der: Uint8Array<ArrayBuffer> } {
  if (typeof pem !== "string" || pem.length === 0 || pem.length > MAX_CERTIFICATE_CHARS) {
    throw invalid("The certificate is missing or too large.");
  }
  const match = PEM.exec(pem.trim());
  if (!match?.[1] || pem.indexOf("-----BEGIN", pem.indexOf("-----BEGIN") + 1) !== -1) {
    throw invalid("Exactly one PEM certificate is required.");
  }
  let binary: string;
  try {
    binary = atob(match[1].replace(/\s+/g, ""));
  } catch {
    throw invalid("The certificate is not valid base64.");
  }
  const der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (der.length < MIN_CERTIFICATE_DER_BYTES || der[0] !== 0x30) {
    throw invalid("The certificate is not a DER certificate.");
  }
  return { pem: `${pem.trim()}\n`, der };
}

function requireNodeId(nodeId: string): void {
  if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) {
    throw invalid("The node id must be a lowercase hostname label of at most 63 characters.");
  }
}

export function createNodeEnrollmentAuthority(options: {
  readonly store: ZelavisSystemStore;
  readonly now?: () => number;
}) {
  const { store } = options;
  const now = options.now ?? (() => Date.now());

  const readEnrollment = (nodeId: string) =>
    Effect.gen(function* () {
      const record = yield* integration(() => store.get(NODE_ENROLLMENT_NAMESPACE, nodeId));
      if (record === undefined) return undefined;
      const stored: unknown = record.value;
      if (!isEnrollmentRecord(stored) || stored.nodeId !== nodeId) {
        return yield* new NodeEnrollmentError({ code: "invalid-request", message: "Stored enrollment is malformed." });
      }
      return { record: stored, updatedAt: record.updatedAt };
    });

  const readNode = (nodeId: string) =>
    Effect.gen(function* () {
      const record = yield* integration(() => store.get(NODE_REGISTRY_NAMESPACE, nodeId));
      if (record === undefined) return undefined;
      const stored: unknown = record.value;
      if (!isNodeRecord(stored) || stored.nodeId !== nodeId) {
        return yield* new NodeEnrollmentError({ code: "invalid-request", message: "Stored node is malformed." });
      }
      return { record: stored, updatedAt: record.updatedAt };
    });

  /** Issue the single-use credential for a node. The plaintext leaves only here. */
  const mint = Effect.fn("NodeEnrollment.mint")(function* (input: MintEnrollmentInput) {
    yield* Effect.try({ try: () => requireNodeId(input.nodeId), catch: (error) => error as NodeEnrollmentError });
    const ttl = input.ttlMs ?? ENROLLMENT_TTL_MS[input.origin];
    if (!(input.origin in ENROLLMENT_TTL_MS) || !Number.isInteger(ttl) || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS) {
      return yield* invalid("The enrollment origin or lifetime is not allowed.");
    }
    if (input.expectedAddress !== undefined &&
        (input.expectedAddress.length === 0 || input.expectedAddress.length > MAX_ADDRESS_CHARS)) {
      return yield* invalid("The expected address is not valid.");
    }
    if ((yield* readNode(input.nodeId)) !== undefined) {
      return yield* new NodeEnrollmentError({ code: "node-exists", message: "A node with this id is already registered." });
    }

    const token = base64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
    const issuedAt = now();
    const record: EnrollmentRecord = {
      v: 1,
      nodeId: input.nodeId,
      origin: input.origin,
      tokenHash: yield* sha256Hex(token),
      createdAt: issuedAt,
      expiresAt: issuedAt + ttl,
      ...(input.expectedAddress === undefined ? {} : { expectedAddress: input.expectedAddress }),
      state: "unused",
    };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const existing = yield* readEnrollment(input.nodeId);
      if (existing === undefined) {
        const created = yield* integration(() =>
          store.setIfAbsent(NODE_ENROLLMENT_NAMESPACE, input.nodeId, record as unknown as ZelavisSystemStoreValue));
        if (created.created) return { nodeId: input.nodeId, token, expiresAt: record.expiresAt } satisfies MintedEnrollment;
        continue;
      }
      const replaceable = existing.record.state === "unused" && (input.replace === true || existing.record.expiresAt <= issuedAt);
      if (!replaceable) {
        return yield* new NodeEnrollmentError({
          code: existing.record.state === "unused" ? "enrollment-pending" : "node-exists",
          message: existing.record.state === "unused"
            ? "An unused enrollment for this node is still valid."
            : "This node has already enrolled.",
        });
      }
      const replaced = yield* integration(() =>
        store.compareAndSet(NODE_ENROLLMENT_NAMESPACE, input.nodeId, existing.updatedAt,
          record as unknown as ZelavisSystemStoreValue, existing.record as unknown as ZelavisSystemStoreValue));
      if (replaced !== undefined) return { nodeId: input.nodeId, token, expiresAt: record.expiresAt } satisfies MintedEnrollment;
    }
    return yield* new NodeEnrollmentError({ code: "contention", message: "Enrollment state is changing; retry." });
  });

  /**
   * A machine presents its token and certificate. The token is consumed before
   * the node is registered, and the same certificate may finish a half-done
   * enrollment.
   */
  const complete = Effect.fn("NodeEnrollment.complete")(function* (input: CompleteEnrollmentInput) {
    const checked = yield* Effect.try({
      try: () => {
        requireNodeId(input.nodeId);
        if (typeof input.token !== "string" || !TOKEN_TEXT.test(input.token)) throw invalid("The token is malformed.");
        if (input.sourceAddress !== undefined && input.sourceAddress.length > MAX_ADDRESS_CHARS) {
          throw invalid("The source address is not valid.");
        }
        return { url: validateAgentUrl(input.url), cert: parseCertificate(input.certPem) };
      },
      catch: (error) => error as NodeEnrollmentError,
    });
    const certSha256 = yield* sha256Hex(checked.cert.der);
    const tokenHash = yield* sha256Hex(input.token);

    let resumed = false;
    let consumed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !consumed; attempt++) {
      const found = yield* readEnrollment(input.nodeId);
      if (found === undefined) return yield* refuse("unknown-node");
      const { record, updatedAt } = found;
      // The token comes first: nothing else about a node is revealed to a caller who does not hold it.
      if (!constantTimeEqual(record.tokenHash, tokenHash)) return yield* refuse("bad-token");
      if (now() > record.expiresAt) return yield* refuse("expired");
      if (record.state === "consumed") {
        if (record.certSha256 !== certSha256) return yield* refuse("already-consumed");
        resumed = true;
        consumed = true;
        break;
      }
      if (record.expectedAddress !== undefined && input.sourceAddress !== undefined &&
          record.expectedAddress !== input.sourceAddress) {
        return yield* refuse("source-mismatch");
      }
      const next: EnrollmentRecord = { ...record, state: "consumed", consumedAt: now(), certSha256 };
      const written = yield* integration(() =>
        store.compareAndSet(NODE_ENROLLMENT_NAMESPACE, input.nodeId, updatedAt,
          next as unknown as ZelavisSystemStoreValue, record as unknown as ZelavisSystemStoreValue));
      if (written !== undefined) consumed = true;
    }
    if (!consumed) return yield* new NodeEnrollmentError({ code: "contention", message: "Enrollment state is changing; retry." });

    const node: NodeRecord = {
      v: 1,
      nodeId: input.nodeId,
      agentId: agentIdFor(input.nodeId),
      url: checked.url,
      caPem: checked.cert.pem,
      certSha256,
      enrolledAt: now(),
      state: "active",
    };
    const created = yield* integration(() =>
      store.setIfAbsent(NODE_REGISTRY_NAMESPACE, input.nodeId, node as unknown as ZelavisSystemStoreValue));
    if (created.created) return { node, resumed } satisfies CompletedEnrollment;

    const existing = yield* readNode(input.nodeId);
    if (existing === undefined) return yield* new NodeEnrollmentError({ code: "contention", message: "Node state is changing; retry." });
    if (existing.record.state === "revoked") return yield* refuse("node-revoked");
    if (existing.record.certSha256 !== certSha256 || existing.record.url !== checked.url) return yield* refuse("node-registered");
    return { node: existing.record, resumed: true } satisfies CompletedEnrollment;
  });

  /** Active nodes, keyed as the dispatcher and Fabric inventory expect. */
  const destinations = Effect.fn("NodeEnrollment.destinations")(function* () {
    const records = yield* integration(() => store.list(NODE_REGISTRY_NAMESPACE));
    const result: Record<string, NodeDestination> = {};
    for (const record of records) {
      const value: unknown = record.value;
      if (isNodeRecord(value) && value.state === "active") {
        result[value.nodeId] = { url: value.url, caPem: value.caPem, agentId: value.agentId };
      }
    }
    return result as Readonly<Record<string, NodeDestination>>;
  });

  /** Enrollments without their credentials: when each was issued, expires and whether it was used. */
  const enrollments = Effect.fn("NodeEnrollment.enrollments")(function* () {
    const records = yield* integration(() => store.list(NODE_ENROLLMENT_NAMESPACE));
    return records.flatMap((record) => {
      const value: unknown = record.value;
      return isEnrollmentRecord(value)
        ? [{ nodeId: value.nodeId, origin: value.origin, createdAt: value.createdAt, expiresAt: value.expiresAt, state: value.state } satisfies EnrollmentSummary]
        : [];
    }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  });

  /** One active node's destination, or undefined for an unknown, malformed or revoked id. */
  const destination = Effect.fn("NodeEnrollment.destination")(function* (nodeId: string) {
    if (typeof nodeId !== "string" || !NODE_ID.test(nodeId)) return undefined;
    const found = yield* readNode(nodeId);
    if (found === undefined || found.record.state !== "active") return undefined;
    return { url: found.record.url, caPem: found.record.caPem, agentId: found.record.agentId } satisfies NodeDestination;
  });

  const nodes = Effect.fn("NodeEnrollment.nodes")(function* () {
    const records = yield* integration(() => store.list(NODE_REGISTRY_NAMESPACE));
    return records.flatMap((record): NodeRecord[] => {
      const value: unknown = record.value;
      return isNodeRecord(value) ? [value] : [];
    }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  });

  /** Leave a tombstone: the certificate no longer matches a destination and the id is not reused. */
  const revoke = Effect.fn("NodeEnrollment.revoke")(function* (nodeId: string) {
    yield* Effect.try({ try: () => requireNodeId(nodeId), catch: (error) => error as NodeEnrollmentError });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const found = yield* readNode(nodeId);
      if (found === undefined) return yield* refuse("unknown-node");
      if (found.record.state === "revoked") return found.record;
      const next: NodeRecord = { ...found.record, state: "revoked", revokedAt: now() };
      const written = yield* integration(() =>
        store.compareAndSet(NODE_REGISTRY_NAMESPACE, nodeId, found.updatedAt,
          next as unknown as ZelavisSystemStoreValue, found.record as unknown as ZelavisSystemStoreValue));
      if (written !== undefined) return next;
    }
    return yield* new NodeEnrollmentError({ code: "contention", message: "Node state is changing; retry." });
  });

  /**
   * Remove unused enrollments past their expiry. `limit` bounds removals; the
   * walk itself is bounded too, so a large store cannot make one call unbounded.
   */
  const prune = Effect.fn("NodeEnrollment.prune")(function* (limit = 100) {
    const maxRemovals = Math.min(Math.max(Math.trunc(limit), 1), MAX_PRUNE);
    const at = now();
    let removed = 0;
    let scanned = 0;
    let after: string | undefined;
    while (removed < maxRemovals && scanned < MAX_PRUNE_SCAN) {
      const page = yield* integration(() =>
        store.page(NODE_ENROLLMENT_NAMESPACE, { limit: PRUNE_PAGE, ...(after === undefined ? {} : { after }) }));
      for (const record of page.records) {
        scanned++;
        if (removed >= maxRemovals) break;
        if (isEnrollmentRecord(record.value) && record.value.state === "unused" && record.value.expiresAt <= at) {
          if (yield* integration(() => store.compareAndDelete(NODE_ENROLLMENT_NAMESPACE, record.key, record.updatedAt))) removed++;
        }
      }
      if (page.next === undefined) break;
      after = page.next;
    }
    return removed;
  });

  return { mint, complete, destination, destinations, nodes, enrollments, revoke, prune };
}

export type NodeEnrollmentAuthority = ReturnType<typeof createNodeEnrollmentAuthority>;
