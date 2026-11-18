/**
 * The Auth runtime: how an Auth mutation or query runs.
 *
 * A mutation is one `documents.transaction` over the Auth partition: its body
 * gets an `AuthTxBase` (the database adapter, the time, the caller's address
 * and a sealed outbox) and runs against one snapshot; the commit re-reads what
 * it read and the body runs again on a conflict via optimistic
 * concurrency. So the body must be repeatable: hashing and network calls
 * happen before it. A query is the same with every write refused.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { requestClientAddress } from "../../core/runtime/client-address.js";
import type { TenantApi } from "../../db/database.js";
import type { DocumentTransaction } from "../../db/document-model.js";
import type { TransactionConflict, TransactionTooLarge } from "../../db/errors.js";
import { EmailCallerIdSchema, EMAIL_KINDS } from "../../app/email/contracts.js";
import { encryptSecret } from "../../edge/acme-crypto.js";
import { type AuthDb, authDb, creationClock, invariant } from "./db.js";

export { AuthInvariantViolation } from "./db.js";

/** What a mutation knows of the request that caused it; `ip` comes only from the trusted client address. */
export interface AuthRequest {
  readonly ip: string | null;
}

/** The request context of a route request (part 2's client address), never a client-supplied header. */
export const authRequest = (request: Request): AuthRequest => ({ ip: requestClientAddress(request) ?? null });

/** No request: background work such as a sweep. */
export const NO_REQUEST: AuthRequest = { ip: null };

/** An email a mutation sends: delivered once, after it commits, through the runtime's email outbox. */
export const AuthEmailPayloadSchema = Schema.Struct({
  kind: Schema.Literals(EMAIL_KINDS),
  to: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  html: Schema.String,
});
export type AuthEmailPayload = typeof AuthEmailPayloadSchema.Type;

export const AUTH_EMAIL_TOPIC = "auth.email";

export interface AuthOutboxMessage {
  readonly topic: typeof AUTH_EMAIL_TOPIC;
  /** The email outbox's caller id: one delivery per id, however often the relay offers it. */
  readonly id: string;
  readonly payload: AuthEmailPayload;
}

export interface AuthTxBase {
  readonly db: AuthDb;
  /** Milliseconds, read once per attempt. */
  readonly now: number;
  readonly request: AuthRequest;
  /** Staged with the writes, sealed: the message exists exactly when they do, and its body (sign-in codes) is never stored in the clear. */
  emit(message: AuthOutboxMessage): Effect.Effect<void, TransactionTooLarge>;
}

export interface AuthRuntime {
  mutation<A, E>(request: AuthRequest, body: (tx: AuthTxBase) => Effect.Effect<A, E>): Effect.Effect<A, E | TransactionConflict | TransactionTooLarge>;
  query<A, E>(request: AuthRequest, body: (tx: AuthTxBase) => Effect.Effect<A, E>): Effect.Effect<A, E>;
}

/** Wakes the outbox relay after a commit that emitted. */
export interface AuthOutboxWaker {
  wake(): void;
}

/** The key outbox payloads are sealed with: bound to its purpose, so no other sealed record decrypts as one. */
export const authOutboxKey = (masterSecret: string) => `${masterSecret}\u0000zelavis.auth.outbox`;

const validId = Schema.is(EmailCallerIdSchema);
const validPayload = Schema.is(AuthEmailPayloadSchema);

// Tags a commit may fail with that ported code never causes on purpose: Auth
// declares no unique index, check or reference, and `ensureTables` creates the
// collections. Seeing one is a defect, not an outcome for the caller.
const COMMIT_DEFECTS = new Set([
  "CollectionNotFound", "DocumentNotFound", "SchemaViolation", "TenantMoving", "IdempotencyKeyReused", "CheckViolation",
  "UniqueViolation", "ReferenceViolation", "VectorShapeMismatch", "InvalidDocumentValue", "MessageExists", "InvalidMessage",
]);

const isCommitDefect = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "_tag" in error && COMMIT_DEFECTS.has(String((error as { _tag: unknown })._tag));

const readOnly = (db: AuthDb): AuthDb => ({
  ...db,
  insert: (table) => invariant(`insert into ${table.collection} in a query`),
  patch: (table) => invariant(`patch of ${table.collection} in a query`),
  replace: (table) => invariant(`replace of ${table.collection} in a query`),
  delete: (table) => invariant(`delete from ${table.collection} in a query`),
});

export function createAuthRuntime(options: {
  readonly tenant: TenantApi;
  readonly masterSecret: string;
  readonly clock?: () => number;
  readonly relay?: AuthOutboxWaker;
}): AuthRuntime {
  const clock = options.clock ?? Date.now;
  const creation = creationClock();
  const key = authOutboxKey(options.masterSecret);

  const txFor = (dtx: DocumentTransaction, request: AuthRequest, writable: boolean, emitted: { value: boolean }): AuthTxBase => {
    const now = clock();
    const db = authDb(dtx, now, creation);
    return {
      db: writable ? db : readOnly(db),
      now,
      request,
      emit: (message) => {
        if (!writable) return invariant("emit in a query");
        if (message.topic !== AUTH_EMAIL_TOPIC || !validId(message.id) || !validPayload(message.payload)) return invariant(`invalid Auth outbox message ${String(message.id)}`);
        emitted.value = true;
        return dtx.emit({ topic: AUTH_EMAIL_TOPIC, id: message.id, payload: { sealed: { ...encryptSecret(JSON.stringify(message.payload), key) } } });
      },
    };
  };

  const run = <A, E>(request: AuthRequest, body: (tx: AuthTxBase) => Effect.Effect<A, E>, writable: boolean) => {
    const emitted = { value: false };
    return options.tenant.documents.transaction((dtx) => Effect.suspend(() => {
      emitted.value = false; // only the attempt that commits counts
      return body(txFor(dtx, request, writable, emitted));
    })).pipe(
      Effect.catchIf(isCommitDefect, (error) => Effect.die(error)),
      Effect.tap(() => Effect.sync(() => {
        if (emitted.value) options.relay?.wake();
      })),
    ) as Effect.Effect<A, E | TransactionConflict | TransactionTooLarge>;
  };

  return {
    mutation: (request, body) => run(request, body, true),
    // A read-only body stages nothing, so nothing commits and nothing conflicts: what can fail is the body's own reads.
    query: <A, E>(request: AuthRequest, body: (tx: AuthTxBase) => Effect.Effect<A, E>) => run(request, body, false) as Effect.Effect<A, E>,
  };
}
