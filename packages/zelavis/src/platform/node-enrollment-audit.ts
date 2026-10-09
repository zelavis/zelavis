import { Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import type { NodeEnrollmentError, NodeEnrollmentReason } from "./node-enrollment.js";

/**
 * What happened to every enrollment attempt the Platform answered.
 *
 * The caller of a refused enrollment learns one opaque word, on purpose; the operator
 * needs the reason (a wrong token, an expired one, a replay of a spent one) to tell a
 * typo from an attack. Nothing secret is kept: never the token, the certificate or the
 * address. The node id is whatever the caller sent, so it is kept only when it has the
 * shape of a node id, and truncated. Attempts the rate limiter turned away are not
 * recorded, so the trail grows at most as fast as the limiter admits, and it is capped
 * by count and age so an attacker cannot fill the store.
 */

export const NODE_ENROLLMENT_AUDIT_NAMESPACE = "fabric.node-enrollment-audit.v1";
export const MAX_ENROLLMENT_AUDIT_RECORDS = 500;
export const ENROLLMENT_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const NODE_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type EnrollmentAuditOutcome = "enrolled" | "refused" | "worker-newer" | "node-exists" | "invalid";

export interface EnrollmentAuditEntry {
  readonly at: number;
  readonly outcome: EnrollmentAuditOutcome;
  /** Only when it looks like a node id. */
  readonly nodeId?: string;
  /** Why a `refused` attempt was refused. */
  readonly reason?: NodeEnrollmentReason;
  readonly version?: string;
}

const VERSION = /^[\da-zA-Z.+-]{1,64}$/;
const asValue = (value: unknown) => value as ZelavisSystemStoreValue;

/** The audit entry for an attempt's result, from what the caller sent and what the authority answered. */
export function enrollmentAuditEntry(input: {
  readonly at: number;
  readonly nodeId: unknown;
  readonly version: unknown;
  readonly error?: NodeEnrollmentError;
}): EnrollmentAuditEntry | undefined {
  const outcome: EnrollmentAuditOutcome | undefined = input.error === undefined ? "enrolled"
    : input.error.code === "refused" ? "refused"
    : input.error.code === "worker-newer" ? "worker-newer"
    : input.error.code === "node-exists" ? "node-exists"
    : input.error.code === "invalid-request" ? "invalid"
    : undefined; // contention is the Platform's own retry, not an attempt's outcome
  if (outcome === undefined) return undefined;
  return {
    at: input.at,
    outcome,
    ...(typeof input.nodeId === "string" && NODE_ID.test(input.nodeId) ? { nodeId: input.nodeId } : {}),
    ...(input.error?.reason === undefined ? {} : { reason: input.error.reason }),
    ...(typeof input.version === "string" && VERSION.test(input.version) ? { version: input.version } : {}),
  };
}

export const recordEnrollmentAttempt = (store: ZelavisSystemStore, entry: EnrollmentAuditEntry) =>
  Effect.gen(function* () {
    const key = `${String(entry.at).padStart(15, "0")}-${crypto.randomUUID()}`;
    yield* integration(() => store.set(NODE_ENROLLMENT_AUDIT_NAMESPACE, key, asValue(entry)));
    // Oldest first: drop what is past its age, then anything beyond the count cap.
    const page = yield* integration(() => store.page(NODE_ENROLLMENT_AUDIT_NAMESPACE, { limit: MAX_ENROLLMENT_AUDIT_RECORDS + 1 }));
    const excess = Math.max(0, page.records.length - MAX_ENROLLMENT_AUDIT_RECORDS);
    const expired = page.records.filter((record) => entry.at - ((record.value as { at?: number }).at ?? entry.at) > ENROLLMENT_AUDIT_RETENTION_MS);
    const doomed = new Set([...page.records.slice(0, excess), ...expired].map((record) => record.key));
    yield* Effect.forEach([...doomed], (doomedKey) => integration(() => store.delete(NODE_ENROLLMENT_AUDIT_NAMESPACE, doomedKey)), { concurrency: 4, discard: true });
  });

/** Newest first. */
export const listEnrollmentAudit = (store: ZelavisSystemStore, limit: number) =>
  integration(() => store.list(NODE_ENROLLMENT_AUDIT_NAMESPACE)).pipe(
    Effect.map((records) => records
      .map((record) => record.value as unknown as EnrollmentAuditEntry)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)),
  );
