/**
 * Security events (Zelavis-own, replacing Identity's `AuthSecurityService`
 * event log): sign-ins, sign-outs, failures, revocations, access edits,
 * second-factor changes and the administration of accounts.
 *
 * An event is written by the transaction of the action it describes, so it
 * exists exactly when that action committed and never for one rolled back.
 * It names accounts by id; the identifier a failed attempt tried (a username
 * or an email address) is kept only as a hash with its method, so the log
 * says that one subject was tried repeatedly without saying who. Nothing
 * secret is ever passed in: no password, code, token or client address.
 *
 * Events are kept 90 days: the `security.retention` sweep removes older
 * ones, at most 200 a run (I8).
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { TenantApi } from "../../db/database.js";
import type { TransactionTooLarge } from "../../db/errors.js";
import { type AuthRuntime, type AuthSweep, type AuthTxBase, NO_REQUEST, SWEEP_BATCH, defineSweep, sha256Base64Url } from "../runtime/index.js";
import { securityTables } from "./tables.js";

/** How long an event is kept. */
export const SECURITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The most events one page lists. */
export const SECURITY_EVENT_PAGE_LIMIT = 200;

export type SecurityEventKind =
  | "authentication.succeeded"
  | "authentication.failed"
  | "account.created"
  | "account.imported"
  | "identity.imported"
  | "identity.import_rebuilt"
  | "identity.oauth_relink_required"
  | "account.access.changed"
  | "session.ended"
  | "session.revoked"
  | "session.reuse_detected"
  | "registration.settings.changed"
  | "bootstrap.owner_created"
  | "mfa.enrolled"
  | "mfa.removed"
  | "mfa.backup_codes_replaced"
  | "mfa.verification_failed"
  | "mfa.policy.changed"
  | "mfa.reset"
  | "service_account.principal_granted"
  | "service_account.created"
  | "service_account.tenant_changed"
  | "service_account.token_rotated"
  | "service_account.revoked"
  | "methods.settings.changed"
  | "role.created"
  | "role.changed"
  | "role.deleted";

export interface SecurityEventInput {
  readonly kind: SecurityEventKind;
  readonly accountId?: string | undefined;
  readonly actorId?: string | undefined;
  /** The subject a failed attempt named; stored only as a hash with its method. */
  readonly subject?: { readonly method: string; readonly identifier: string } | undefined;
  readonly detail?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** The hash a subject is recorded under: SHA-256 of `<method>\0<identifier>`, the identifier trimmed and lower-cased. */
export const subjectHashOf = (method: string, identifier: string): Effect.Effect<string> =>
  sha256Base64Url(`${method}\u0000${identifier.trim().toLowerCase()}`);

/** Record an event in the transaction `tx`: it commits with the action, or not at all. */
export const recordSecurityEvent = Effect.fn("auth.security.record")(function* (tx: AuthTxBase, event: SecurityEventInput) {
  const subjectHash = event.subject === undefined ? undefined : yield* subjectHashOf(event.subject.method, event.subject.identifier);
  yield* tx.db.insert(securityTables.events, {
    at: tx.now,
    kind: event.kind,
    ...(subjectHash === undefined ? {} : { subjectHash }),
    ...(event.accountId === undefined ? {} : { accountId: event.accountId }),
    ...(event.actorId === undefined ? {} : { actorId: event.actorId }),
    detail: { ...(event.detail ?? {}) },
  });
});

export interface SecurityEventView {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly accountId?: string;
  readonly actorId?: string;
  readonly subjectHash?: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A page of events, newest first. `before` is the `next` of the page before;
 * pages are cut by insertion order, which strictly increases, so no event is
 * listed twice or skipped while new ones arrive.
 */
export const listSecurityEvents = Effect.fn("auth.security.list")(function* (
  tx: AuthTxBase,
  args: { readonly limit: number; readonly before?: number | undefined },
): Effect.fn.Return<{ events: ReadonlyArray<SecurityEventView>; next?: number }, TransactionTooLarge> {
  const limit = Math.max(1, Math.min(SECURITY_EVENT_PAGE_LIMIT, Math.floor(args.limit)));
  const before = args.before;
  const rows = yield* tx.db.query(securityTables.events)
    .withIndex("by_creation_time", before === undefined ? undefined : (q) => q.lt("_creationTime", before))
    .order("desc")
    .take(limit + 1);
  const page = rows.slice(0, limit);
  const events = page.map((row): SecurityEventView => ({
    id: row._id,
    type: row.kind,
    occurredAt: new Date(row.at).toISOString(),
    ...(row.accountId === undefined ? {} : { accountId: row.accountId }),
    ...(row.actorId === undefined ? {} : { actorId: row.actorId }),
    ...(row.subjectHash === undefined ? {} : { subjectHash: row.subjectHash }),
    detail: row.detail,
  }));
  const last = page[page.length - 1];
  return rows.length > limit && last !== undefined ? { events, next: last._creationTime } : { events };
});

/**
 * The `security.retention` sweep: removes events older than
 * {@link SECURITY_EVENT_RETENTION_MS}, oldest first, at most `SWEEP_BATCH` a
 * run. Each removal is its own transaction; a row it cannot remove is logged
 * by collection and id and skipped (I8).
 */
export function createSecurityRetentionSweep(tenant: TenantApi, clock: () => number = Date.now): AuthSweep<AuthRuntime> {
  const collection = securityTables.events.collection;
  // Moves past rows a run could not remove, so they never hold the sweep back (I8).
  let cursor = 0;
  return defineSweep({
    name: "security.retention",
    everyMs: 60 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      const cutoff = clock() - SECURITY_EVENT_RETENTION_MS;
      const documents = yield* tenant.documents.findMany({
        collection,
        where: [{ path: "at", op: "gte", value: cursor }, { path: "at", op: "lt", value: cutoff }],
        orderBy: [{ path: "at", direction: "asc" }],
        limit: SWEEP_BATCH,
      }).pipe(Effect.orDie);
      let removed = 0;
      for (const document of documents) {
        const deleted = yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          const row = yield* tx.db.get(securityTables.events, document.id);
          if (row === null || row.at >= cutoff) return false;
          yield* tx.db.delete(securityTables.events, document.id);
          return true;
        })).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.as(Effect.logWarning(`Auth sweep security.retention skipped ${collection} row ${document.id}.`, cause), false),
          ),
        );
        if (deleted) removed += 1;
      }
      const last = documents[documents.length - 1]?.data.at;
      cursor = documents.length >= SWEEP_BATCH && typeof last === "number" ? last : 0;
      return removed;
    }),
  });
}
