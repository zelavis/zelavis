import { Cause, Clock, Duration, Effect, Exit, PubSub, type Scope, Semaphore } from "effect";
import { isJsonObject, isJsonValue, isNonNegativeInteger, isString, objectFields, optional, parseJson } from "../core/json-validation.js";
import type { DocumentsApi, DocumentWrite, OutboxEmit } from "./document-model.js";
import { WRITE_ALONG, type WriteAlongInput } from "./document-writes.js";
import { dieUnlessMoving, type DbError, InvalidEntityMessage, MailboxFull, type TenantMoving } from "./errors.js";
import type { Json, JsonObject } from "./json.js";
import { emptyManifest, type ObjectIdentity, type PartitionKey, type Seq } from "./model.js";
import { isReservedTenantId } from "./naming.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import { ENTITY_DONE_NAMESPACE, ENTITY_MESSAGE_NAMESPACE, ENTITY_PENDING_NAMESPACE, ENTITY_STATE_NAMESPACE } from "./tenancy.js";
import { GLOBAL_TENANT, type TenantId } from "./topology.js";

/**
 * Durable entities: actors whose mailbox and state live in their Tenant's own partition.
 *
 * An entity is addressed by a type and an id inside a Tenant (`order`/`4711`, `chat`/`#engineering`). Sending it a
 * message is one write to the Tenant: the message, a marker that it is still owed, and the entity's count, in one
 * batch. Nothing has to be running for a message to be kept, and nothing is lost when what processes it stops:
 * the marker is the intent to process it, and it stays until a handler has finished with it.
 *
 * A handler sees one message and the entity's state, and answers a step: the document writes to make, the outbox
 * messages to emit, the entity's new state and a reply. All of that and the message's processed mark commit in one
 * batch of the Tenant's partition, or none of it does. Delivery is at least once — a handler can run again for the
 * same message after a crash, a timeout or a lost commit — and its effects on the database land exactly once,
 * because they land only with the mark. What a handler does outside the database it does through the outbox, whose
 * consumers deduplicate by message id.
 *
 * Messages are processed one at a time per entity, in the order they arrived; one that fails is retried after a
 * growing pause (at most `maxAttempts` times, then it is `failed` and the next one goes on), and one sent with
 * `deliverAt` waits until then. A `primaryKey` names the message: sending the same key again is answered with the
 * message already there, not a second one, for as long as finished messages are kept (`retention`). A mailbox
 * holds at most `capacity` unfinished messages (`MailboxFull`).
 *
 * Routing an entity is routing its Tenant: a moved Tenant takes its mailboxes, and a handler's commit checks that
 * its message is still the one owed, so a message is never finished twice whichever process gets there.
 */

/** A message as an entity's mailbox holds it. */
export interface EntityMessage {
  readonly type: string;
  readonly id: string;
  /** The message's name in this entity's mailbox: its `primaryKey`, or one generated when it was sent. */
  readonly messageKey: string;
  readonly tag: string;
  readonly payload: JsonObject;
  readonly sentAt: string;
  readonly deliverAt?: string;
  readonly status: "pending" | "processed" | "failed" | "cancelled";
  /** Times a handler finished with it, successfully or not. */
  readonly attempts: number;
  readonly lastError?: string;
  /** What the handler answered, once processed. */
  readonly reply?: Json;
  readonly finishedAt?: string;
}

/** An entity's own state and counts. */
export interface EntityState {
  readonly type: string;
  readonly id: string;
  readonly state: JsonObject | null;
  readonly pending: number;
  readonly processed: number;
  readonly failed: number;
  readonly updatedAt: string;
}

/** What a handler answers for one message: all of it commits with the message's processed mark, or none of it. */
export interface EntityStep {
  /** Document writes to the entity's Tenant, as `documents.write` takes them. */
  readonly writes?: ReadonlyArray<DocumentWrite>;
  /** Outbox messages emitted with them, for what happens outside the database. */
  readonly emit?: ReadonlyArray<OutboxEmit>;
  /** The entity's new state; `null` clears it, absent keeps it. */
  readonly state?: JsonObject | null;
  /** The reply kept with the message. */
  readonly reply?: Json;
}

export interface EntityContext {
  readonly tenant: TenantId;
  /** The entity's state as of before this message. */
  readonly state: JsonObject | null;
  /** The Tenant's documents, for reading; writes go in the step, so they commit with the message. */
  readonly documents: DocumentsApi;
}

export type EntityHandler = (message: EntityMessage, context: EntityContext) => Effect.Effect<EntityStep, unknown>;

export interface EntitySend {
  readonly type: string;
  readonly id: string;
  readonly tag: string;
  readonly payload: JsonObject;
  /** Names the message: a send with a key the mailbox already holds is that message, not another. */
  readonly primaryKey?: string;
  /** Not processed before this time (ISO 8601). */
  readonly deliverAt?: string;
}

/** What processing one entity's next message came to. */
export type EntityOutcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Waiting"; readonly until: number }
  | { readonly _tag: "Processed"; readonly messageKey: string }
  | { readonly _tag: "Retrying"; readonly messageKey: string; readonly attempts: number; readonly until: number }
  | { readonly _tag: "Failed"; readonly messageKey: string; readonly error: string }
  /** The message stopped being the one owed while its handler ran (cancelled, or finished by someone else). */
  | { readonly _tag: "Superseded"; readonly messageKey: string };

export interface EntityProcessOptions {
  /** Attempts before a message is `failed`; 8 unless given. */
  readonly maxAttempts?: number;
  /** How long a handler may run before the attempt counts as failed; one minute unless given. */
  readonly handlerTimeout?: Duration.Input;
}

export interface EntitiesApi {
  /** Put a message in an entity's mailbox, or answer the one its `primaryKey` already names (`duplicate`). */
  readonly send: (input: EntitySend) => Effect.Effect<
    { readonly message: EntityMessage; readonly duplicate: boolean }, InvalidEntityMessage | MailboxFull | TenantMoving
  >;
  readonly message: (input: { readonly type: string; readonly id: string; readonly messageKey: string }) =>
    Effect.Effect<EntityMessage | undefined, InvalidEntityMessage>;
  readonly state: (input: { readonly type: string; readonly id: string }) => Effect.Effect<EntityState | undefined, InvalidEntityMessage>;
  /** The messages an entity still owes, oldest first, a page at a time. */
  readonly mailbox: (input: { readonly type: string; readonly id: string; readonly after?: string; readonly limit?: number }) =>
    Effect.Effect<{ readonly messages: ReadonlyArray<EntityMessage>; readonly next?: string }, InvalidEntityMessage>;
  /** The entities of a type, by id, a page at a time. */
  readonly list: (input: { readonly type: string; readonly after?: string; readonly limit?: number }) =>
    Effect.Effect<{ readonly entities: ReadonlyArray<EntityState>; readonly next?: string }, InvalidEntityMessage>;
  /** Cancel a message not yet processed; one already finished stays as it is (`cancelled: false`). */
  readonly cancel: (input: { readonly type: string; readonly id: string; readonly messageKey: string }) =>
    Effect.Effect<{ readonly cancelled: boolean; readonly message?: EntityMessage }, InvalidEntityMessage | TenantMoving>;
  /** Process an entity's next message with `handler`, if one is due. */
  readonly process: (type: string, id: string, handler: EntityHandler, options?: EntityProcessOptions) =>
    Effect.Effect<EntityOutcome, InvalidEntityMessage | TenantMoving>;
  /** The entities with messages owed, each with when its next one is due, at most `limit` (1 to 1000). */
  readonly due: (input?: { readonly limit?: number }) =>
    Effect.Effect<ReadonlyArray<{ readonly type: string; readonly id: string; readonly notBefore: number }>>;
  /** Remove finished messages that finished before `before` (epoch milliseconds), at most `limit` a call. */
  readonly prune: (input: { readonly before: number; readonly limit?: number }) => Effect.Effect<{ readonly removed: number }, TenantMoving>;
}

export const ENTITY_MAILBOX_CAPACITY = 4096;
const TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TAG = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const NAME_LIMIT = 256;
const PAYLOAD_LIMIT = 256 * 1024;
const PAGE_LIMIT = 1000;
const MAX_ATTEMPTS = 8;
const RETRY_BASE_MILLIS = 1000;
const RETRY_CAP_MILLIS = 5 * 60_000;
const HANDLER_TIMEOUT: Duration.Input = "1 minute";
const STEP_WRITE_LIMIT = 1000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const part = (value: string) => encodeURIComponent(value);
const position = (value: number) => String(value).padStart(15, "0");
const entityKey = (type: string, id: string) => `${part(type)}/${part(id)}`;
const messageIdentity = (type: string, id: string, key: string): ObjectIdentity =>
  ({ namespace: ENTITY_MESSAGE_NAMESPACE, key: `${entityKey(type, id)}/${part(key)}` });
const stateIdentity = (type: string, id: string): ObjectIdentity => ({ namespace: ENTITY_STATE_NAMESPACE, key: entityKey(type, id) });

interface StoredMessage {
  readonly type: string;
  readonly id: string;
  readonly key: string;
  readonly tag: string;
  readonly payload: JsonObject;
  readonly sentAt: string;
  readonly deliverAt?: string;
  readonly status: EntityMessage["status"];
  readonly attempts: number;
  readonly lastError?: string;
  readonly reply?: Json;
  readonly finishedAt?: string;
  /** The key of its pending marker while it is owed. */
  readonly marker?: string;
}
interface StoredState {
  readonly type: string;
  readonly id: string;
  readonly state: JsonObject | null;
  readonly pending: number;
  readonly processed: number;
  readonly failed: number;
  readonly updatedAt: string;
}
interface StoredMarker { readonly key: string; readonly notBefore: number }

const isStatus = (value: unknown): value is EntityMessage["status"] =>
  value === "pending" || value === "processed" || value === "failed" || value === "cancelled";
const storedMessage = objectFields<StoredMessage>({
  type: isString, id: isString, key: isString, tag: isString, payload: isJsonObject, sentAt: isString,
  deliverAt: optional(isString), status: isStatus, attempts: isNonNegativeInteger, lastError: optional(isString),
  reply: optional(isJsonValue), finishedAt: optional(isString), marker: optional(isString),
});
const storedState = objectFields<StoredState>({
  type: isString, id: isString, state: (value): value is JsonObject | null => value === null || isJsonObject(value),
  pending: isNonNegativeInteger, processed: isNonNegativeInteger, failed: isNonNegativeInteger, updatedAt: isString,
});
const storedMarker = objectFields<StoredMarker>({ key: isString, notBefore: isNonNegativeInteger });

const publicOf = (stored: StoredMessage): EntityMessage => {
  const { key, marker: _marker, ...rest } = stored;
  return { ...rest, messageKey: key };
};

const refuse = (reason: string) => new InvalidEntityMessage({ reason });

const checkAddress = (type: unknown, id: unknown) =>
  typeof type !== "string" || !TYPE.test(type)
    ? Effect.fail(refuse("an entity type is a letter, then up to 63 letters, digits, `_` or `-`"))
    : typeof id !== "string" || id.length === 0 || id.length > NAME_LIMIT
      ? Effect.fail(refuse(`an entity id is 1 to ${NAME_LIMIT} characters`))
      : Effect.void;

const checkKey = (key: unknown, what: string) =>
  typeof key !== "string" || key.length === 0 || key.length > NAME_LIMIT
    ? Effect.fail(refuse(`${what} is 1 to ${NAME_LIMIT} characters`))
    : Effect.void;

const checkLimit = (limit: unknown, fallback: number) =>
  limit === undefined
    ? Effect.succeed(fallback)
    : typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= PAGE_LIMIT
      ? Effect.succeed(limit)
      : Effect.fail(refuse(`a page holds 1 to ${PAGE_LIMIT} entries`));

/** A step as a handler answered it, checked before anything is written. */
const checkStep = (step: unknown): Effect.Effect<EntityStep, InvalidEntityMessage> => {
  if (step === undefined || step === null) return Effect.succeed({});
  if (typeof step !== "object" || Array.isArray(step)) return Effect.fail(refuse("a handler answers an object: { writes?, emit?, state?, reply? }"));
  const value = step as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!["writes", "emit", "state", "reply"].includes(key)) return Effect.fail(refuse(`a handler's step has no "${key}"`));
  }
  if (value.writes !== undefined && (!Array.isArray(value.writes) || value.writes.length > STEP_WRITE_LIMIT)) {
    return Effect.fail(refuse(`"writes" is a list of at most ${STEP_WRITE_LIMIT} document writes`));
  }
  if (value.emit !== undefined && !Array.isArray(value.emit)) return Effect.fail(refuse(`"emit" is a list of outbox messages`));
  if (value.state !== undefined && value.state !== null && !isJsonObject(value.state)) return Effect.fail(refuse(`"state" is a JSON object, or null`));
  if (value.reply !== undefined && !isJsonValue(value.reply)) return Effect.fail(refuse(`"reply" is a JSON value`));
  return Effect.succeed(value as EntityStep);
};

/** A failure as one line for the message's `lastError`: a tagged error by its name and fields, any other by its message. */
const describe = (cause: unknown): string => {
  const error = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (!(error instanceof Error)) return String(error).slice(0, 2000);
  const tag = (error as { readonly _tag?: unknown })._tag;
  const fields = Object.entries(error).filter(([key]) => key !== "_tag" && key !== "stack" && key !== "message");
  const detail = error.message !== "" ? error.message : fields.map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(", ");
  return `${typeof tag === "string" ? tag : error.name}: ${detail}`.slice(0, 2000);
};

/** The message stopped being the one owed while its handler ran. Internal to processing. */
class Superseded extends Error {
  readonly _tag = "EntityMessageSuperseded";
}

/** The failures of a document batch that are the handler's to answer for: its step is refused and retried. */
const STEP_FAILURES: ReadonlySet<string> = new Set([
  "CollectionNotFound", "DocumentConflict", "DocumentNotFound", "SchemaViolation", "IdempotencyKeyReused", "CheckViolation",
  "UniqueViolation", "ReferenceViolation", "VectorShapeMismatch", "InvalidDocumentValue", "MessageExists", "InvalidMessage",
]);

export const entitiesFor = (
  store: ObjectStoreApi,
  documents: DocumentsApi,
  tenant: TenantId,
  wake: Effect.Effect<void>,
): EntitiesApi => {
  const readNamed = <A>(identity: ObjectIdentity, validate: (value: unknown) => value is A, label: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(identity.namespace, identity.key);
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      if (object === undefined) return undefined;
      return { seq, version: object.version, value: parseJson(dec.decode(object.bytes), validate, label) };
    });
  const put = (txn: Txn, seq: Seq, value: unknown, identity: ObjectIdentity) =>
    txn.put(seq, enc.encode(JSON.stringify(value)), emptyManifest, identity);
  const fresh = (type: string, id: string, at: string): StoredState =>
    ({ type, id, state: null, pending: 0, processed: 0, failed: 0, updatedAt: at });
  const nowIso = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

  /** Finish a message that was owed: its marker goes, it is recorded as finished, and its entity's counts move. */
  const finish = (txn: Txn, markerSeq: Seq, message: { readonly seq: Seq; readonly value: StoredMessage }, finished: StoredMessage,
    state: StoredState, stateSeq: Seq | undefined, change: (state: StoredState) => StoredState, at: number) =>
    Effect.gen(function* () {
      yield* txn.retract(markerSeq);
      const { marker: _marker, ...rest } = finished;
      yield* put(txn, message.seq, rest, messageIdentity(message.value.type, message.value.id, message.value.key));
      yield* put(txn, yield* txn.allocate, {}, { namespace: ENTITY_DONE_NAMESPACE, key: `${position(at)}/${messageIdentity(message.value.type, message.value.id, message.value.key).key}` });
      yield* put(txn, stateSeq ?? (yield* txn.allocate), change(state), stateIdentity(state.type, state.id));
    });

  const api: EntitiesApi = {
    send: (input) =>
      Effect.gen(function* () {
        yield* checkAddress(input.type, input.id);
        if (typeof input.tag !== "string" || !TAG.test(input.tag)) return yield* refuse("a tag is a letter, then up to 63 letters, digits, `_`, `.`, `:` or `-`");
        if (!isJsonObject(input.payload)) return yield* refuse("a payload is a JSON object, with finite numbers only");
        if (JSON.stringify(input.payload).length > PAYLOAD_LIMIT) return yield* refuse(`a payload is at most ${PAYLOAD_LIMIT} characters of JSON`);
        if (input.primaryKey !== undefined) yield* checkKey(input.primaryKey, "a primary key");
        const notBefore = input.deliverAt === undefined ? 0 : Date.parse(input.deliverAt);
        if (!Number.isFinite(notBefore) || notBefore < 0) return yield* refuse("deliverAt is an ISO 8601 time");
        const key = input.primaryKey ?? crypto.randomUUID();
        const sentAt = yield* nowIso;
        const answer = yield* dieUnlessMoving(store.transact((txn) =>
          Effect.gen(function* () {
            const existing = yield* readNamed(messageIdentity(input.type, input.id, key), storedMessage, "entity message");
            if (existing !== undefined) return { message: publicOf(existing.value), duplicate: true };
            const stateRecord = yield* readNamed(stateIdentity(input.type, input.id), storedState, "entity state");
            const state = stateRecord?.value ?? fresh(input.type, input.id, sentAt);
            if (state.pending >= ENTITY_MAILBOX_CAPACITY) {
              return yield* new MailboxFull({ type: input.type, id: input.id, capacity: ENTITY_MAILBOX_CAPACITY });
            }
            const seq = yield* txn.allocate;
            const marker = `${entityKey(input.type, input.id)}/${position(seq)}`;
            const message: StoredMessage = {
              type: input.type, id: input.id, key, tag: input.tag, payload: input.payload, sentAt,
              ...(input.deliverAt === undefined ? {} : { deliverAt: new Date(notBefore).toISOString() }),
              status: "pending", attempts: 0, marker,
            };
            yield* put(txn, seq, message, messageIdentity(input.type, input.id, key));
            yield* put(txn, yield* txn.allocate, { key, notBefore } satisfies StoredMarker, { namespace: ENTITY_PENDING_NAMESPACE, key: marker });
            yield* put(txn, stateRecord?.seq ?? (yield* txn.allocate), { ...state, pending: state.pending + 1, updatedAt: sentAt }, stateIdentity(input.type, input.id));
            return { message: publicOf(message), duplicate: false };
          })));
        if (!answer.duplicate) yield* wake;
        return answer;
      }),

    message: (input) =>
      Effect.gen(function* () {
        yield* checkAddress(input.type, input.id);
        yield* checkKey(input.messageKey, "a message key");
        const found = yield* Effect.orDie(readNamed(messageIdentity(input.type, input.id, input.messageKey), storedMessage, "entity message"));
        return found === undefined ? undefined : publicOf(found.value);
      }),

    state: (input) =>
      Effect.gen(function* () {
        yield* checkAddress(input.type, input.id);
        const found = yield* Effect.orDie(readNamed(stateIdentity(input.type, input.id), storedState, "entity state"));
        return found?.value;
      }),

    mailbox: (input) =>
      Effect.gen(function* () {
        yield* checkAddress(input.type, input.id);
        const limit = yield* checkLimit(input.limit, 100);
        return yield* Effect.orDie(store.reading(Effect.gen(function* () {
          const markers = yield* store.scanIdentities({
            namespace: ENTITY_PENDING_NAMESPACE, prefix: `${entityKey(input.type, input.id)}/`,
            ...(input.after === undefined ? {} : { after: input.after }), limit,
          });
          const messages: EntityMessage[] = [];
          for (const entry of markers) {
            const marker = yield* store.read(entry.seq);
            if (marker === undefined) continue;
            const { key } = parseJson(dec.decode(marker.bytes), storedMarker, "entity marker");
            const found = yield* readNamed(messageIdentity(input.type, input.id, key), storedMessage, "entity message");
            if (found !== undefined) messages.push(publicOf(found.value));
          }
          return { messages, ...(markers.length === limit ? { next: markers[markers.length - 1]!.key } : {}) };
        })));
      }),

    list: (input) =>
      Effect.gen(function* () {
        if (typeof input.type !== "string" || !TYPE.test(input.type)) return yield* refuse("an entity type is a letter, then up to 63 letters, digits, `_` or `-`");
        const limit = yield* checkLimit(input.limit, 100);
        return yield* Effect.orDie(store.reading(Effect.gen(function* () {
          const found = yield* store.scanIdentities({
            namespace: ENTITY_STATE_NAMESPACE, prefix: `${part(input.type)}/`,
            ...(input.after === undefined ? {} : { after: input.after }), limit,
          });
          const entities: EntityState[] = [];
          for (const entry of found) {
            const object = yield* store.read(entry.seq);
            if (object !== undefined) entities.push(parseJson(dec.decode(object.bytes), storedState, "entity state"));
          }
          return { entities, ...(found.length === limit ? { next: found[found.length - 1]!.key } : {}) };
        })));
      }),

    cancel: (input) =>
      Effect.gen(function* () {
        yield* checkAddress(input.type, input.id);
        yield* checkKey(input.messageKey, "a message key");
        const at = yield* Clock.currentTimeMillis;
        return yield* dieUnlessMoving(store.transact((txn) =>
          Effect.gen(function* () {
            const message = yield* readNamed(messageIdentity(input.type, input.id, input.messageKey), storedMessage, "entity message");
            if (message === undefined) return { cancelled: false };
            if (message.value.status !== "pending" || message.value.marker === undefined) return { cancelled: false, message: publicOf(message.value) };
            const markerSeq = yield* store.lookup(ENTITY_PENDING_NAMESPACE, message.value.marker);
            const stateRecord = yield* readNamed(stateIdentity(input.type, input.id), storedState, "entity state");
            const state = stateRecord?.value ?? fresh(input.type, input.id, new Date(at).toISOString());
            const cancelled: StoredMessage = { ...message.value, status: "cancelled", finishedAt: new Date(at).toISOString() };
            if (markerSeq === undefined) return yield* Effect.die(new Error(`entity message ${input.messageKey} is pending with no marker`));
            yield* finish(txn, markerSeq, message, cancelled, state, stateRecord?.seq,
              (current) => ({ ...current, pending: Math.max(0, current.pending - 1), updatedAt: new Date(at).toISOString() }), at);
            return { cancelled: true, message: publicOf(cancelled) };
          })));
      }),

    process: (type, id, handler, options) =>
      Effect.gen(function* () {
        yield* checkAddress(type, id);
        const maxAttempts = options?.maxAttempts ?? MAX_ATTEMPTS;
        const head = (yield* Effect.orDie(store.scanIdentities({ namespace: ENTITY_PENDING_NAMESPACE, prefix: `${entityKey(type, id)}/`, limit: 1 })))[0];
        if (head === undefined) return { _tag: "Idle" } as const;
        const markerObject = yield* Effect.orDie(store.read(head.seq));
        if (markerObject === undefined) return { _tag: "Idle" } as const;
        const marker = parseJson(dec.decode(markerObject.bytes), storedMarker, "entity marker");
        const started = yield* Clock.currentTimeMillis;
        if (marker.notBefore > started) return { _tag: "Waiting", until: marker.notBefore } as const;
        const message = yield* Effect.orDie(readNamed(messageIdentity(type, id, marker.key), storedMessage, "entity message"));
        if (message === undefined) return yield* Effect.die(new Error(`entity ${type}/${id} owes message ${marker.key}, which it does not hold`));
        const stateRecord = yield* Effect.orDie(readNamed(stateIdentity(type, id), storedState, "entity state"));
        const state = stateRecord?.value ?? fresh(type, id, new Date(started).toISOString());

        /** Inside a commit: the marker read before the handler ran is still the one owed, unchanged. */
        const stillOwed = Effect.gen(function* () {
          const current = yield* store.read(head.seq);
          if (current === undefined || current.version !== markerObject.version) return yield* Effect.fail(new Superseded());
        });
        const superseded = { _tag: "Superseded", messageKey: marker.key } as const;

        /** A failed attempt: retried after a pause that doubles each time, or `failed` once attempts run out. */
        const failAttempt = (error: string) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            const attempts = message.value.attempts + 1;
            const outcome = yield* store.transact((txn) =>
              Effect.gen(function* () {
                yield* stillOwed;
                if (attempts >= maxAttempts) {
                  const failed: StoredMessage = { ...message.value, status: "failed", attempts, lastError: error, finishedAt: new Date(at).toISOString() };
                  yield* finish(txn, head.seq, message, failed, state, stateRecord?.seq, (current) =>
                    ({ ...current, pending: Math.max(0, current.pending - 1), failed: current.failed + 1, updatedAt: new Date(at).toISOString() }), at);
                  return { _tag: "Failed", messageKey: marker.key, error } as const;
                }
                const until = at + Math.min(RETRY_BASE_MILLIS * 2 ** (attempts - 1), RETRY_CAP_MILLIS);
                yield* put(txn, head.seq, { key: marker.key, notBefore: until } satisfies StoredMarker, { namespace: ENTITY_PENDING_NAMESPACE, key: head.key });
                yield* put(txn, message.seq, { ...message.value, attempts, lastError: error }, messageIdentity(type, id, marker.key));
                return { _tag: "Retrying", messageKey: marker.key, attempts, until } as const;
              })).pipe(Effect.catch((failure) => failure instanceof Superseded ? Effect.succeed(superseded) : Effect.fail(failure)));
            return outcome;
          });

        const ran = yield* Effect.exit(Effect.suspend(() => handler(publicOf(message.value), { tenant, state: state.state, documents })).pipe(
          Effect.timeout(options?.handlerTimeout ?? HANDLER_TIMEOUT),
          Effect.flatMap(checkStep),
        ));
        if (Exit.isFailure(ran)) return yield* dieUnlessMoving(failAttempt(describe(ran.cause)));
        const step = ran.value;
        const at = yield* Clock.currentTimeMillis;
        const input = {
          operations: step.writes ?? [],
          ...(step.emit === undefined ? {} : { emit: step.emit }),
          [WRITE_ALONG]: (txn: Txn) => Effect.gen(function* () {
            yield* stillOwed;
            const processed: StoredMessage = {
              ...message.value, status: "processed", attempts: message.value.attempts + 1, reply: step.reply ?? null,
              finishedAt: new Date(at).toISOString(),
            };
            yield* finish(txn, head.seq, message, processed, state, stateRecord?.seq, (current) => ({
              ...current, state: step.state === undefined ? current.state : step.state,
              pending: Math.max(0, current.pending - 1), processed: current.processed + 1, updatedAt: new Date(at).toISOString(),
            }), at);
          }),
        } satisfies Parameters<DocumentsApi["write"]>[0] & WriteAlongInput;
        const committed = yield* Effect.exit(documents.write(input) as Effect.Effect<unknown, unknown>);
        if (Exit.isSuccess(committed)) return { _tag: "Processed", messageKey: marker.key } as const;
        const failure = Cause.squash(committed.cause);
        if (failure instanceof Superseded) return superseded;
        const tag = (failure as { readonly _tag?: unknown })._tag;
        if (tag === "TenantMoving") return yield* Effect.fail(failure as TenantMoving);
        if (typeof tag === "string" && STEP_FAILURES.has(tag)) return yield* dieUnlessMoving(failAttempt(describe(failure)));
        return yield* Effect.failCause(committed.cause as Cause.Cause<never>);
      }),

    due: (input) =>
      Effect.orDie(store.reading(Effect.gen(function* () {
        const limit = input?.limit ?? 256;
        const heads = new Map<string, { type: string; id: string; notBefore: number }>();
        let after: string | undefined;
        // Keys sort by entity, then arrival: the first of each entity is its head. Read until `limit` entities.
        for (let pages = 0; heads.size < limit && pages < 16; pages++) {
          const markers = yield* store.scanIdentities({ namespace: ENTITY_PENDING_NAMESPACE, ...(after === undefined ? {} : { after }), limit: PAGE_LIMIT });
          for (const entry of markers) {
            const [typePart, idPart] = entry.key.split("/");
            const entity = `${typePart}/${idPart}`;
            if (heads.has(entity)) continue;
            const object = yield* store.read(entry.seq);
            if (object === undefined) continue;
            const marker = parseJson(dec.decode(object.bytes), storedMarker, "entity marker");
            heads.set(entity, { type: decodeURIComponent(typePart!), id: decodeURIComponent(idPart!), notBefore: marker.notBefore });
            if (heads.size >= limit) break;
          }
          if (markers.length < PAGE_LIMIT) break;
          after = markers[markers.length - 1]!.key;
        }
        return [...heads.values()];
      }))),

    prune: (input) =>
      dieUnlessMoving(Effect.gen(function* () {
        const limit = Math.min(Math.max(1, input.limit ?? 256), PAGE_LIMIT);
        const done = yield* store.scanIdentities({ namespace: ENTITY_DONE_NAMESPACE, upper: position(input.before), limit });
        if (done.length === 0) return { removed: 0 };
        yield* store.transact((txn) => Effect.gen(function* () {
          for (const entry of done) {
            yield* txn.retract(entry.seq);
            const messageKey = entry.key.slice(entry.key.indexOf("/") + 1);
            const seq = yield* store.lookup(ENTITY_MESSAGE_NAMESPACE, messageKey);
            if (seq !== undefined) yield* txn.retract(seq);
          }
        }));
        return { removed: done.length };
      })),
  };
  return api;
};

export interface EntityServeOptions {
  /** The handler for a type, asked for every message, so handlers can change while serving; none leaves its messages owed. */
  readonly handlers: (type: string) => EntityHandler | undefined;
  /** Entities processed at once; 8 unless given. */
  readonly concurrency?: number;
  /** How often every partition is looked at, for messages sent elsewhere and messages that became due; one second unless given. */
  readonly sweepInterval?: Duration.Input;
  /** How long finished messages are kept, and so how long a `primaryKey` is remembered; seven days unless given. */
  readonly retention?: Duration.Input;
  readonly maxAttempts?: number;
  readonly handlerTimeout?: Duration.Input;
}

/**
 * A wait that never keeps the host alive on its own: the runner lives as long as its scope, and a process that ends
 * without stopping it must still end rather than wait on its sweep timer.
 */
export const unrefSleep = (millis: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), millis);
    (timer as { unref?: () => void }).unref?.();
    return Effect.sync(() => clearTimeout(timer));
  });

/** Messages one entity is given in a row before others get a turn. */
const TURN = 32;

/**
 * Process every partition's due messages with `options.handlers` until interrupted: a partition named by `wakes`
 * (a send in this process) at once, every partition on each sweep. Runs where the database's writer is: the commit
 * of every step checks its message is still owed, so two of these over one database never finish a message twice,
 * but one per writer is the design.
 */
export const serveEntities = (input: {
  readonly partitions: Effect.Effect<ReadonlyArray<PartitionKey>, DbError>;
  readonly entities: (partition: PartitionKey) => EntitiesApi;
  readonly wakes: PubSub.PubSub<PartitionKey>;
  readonly options: EntityServeOptions;
}): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    const options = input.options;
    const permits = yield* Semaphore.make(Math.max(1, options.concurrency ?? 8));
    const busy = new Set<string>();
    const processOptions: EntityProcessOptions = {
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.handlerTimeout === undefined ? {} : { handlerTimeout: options.handlerTimeout }),
    };
    const retentionMillis = Duration.toMillis(options.retention ?? "7 days");
    const sweepMillis = Duration.toMillis(options.sweepInterval ?? "1 second");

    /** One entity's messages in a row, until it has none due or its turn is up. */
    const drain = (partition: PartitionKey, type: string, id: string, handler: EntityHandler) =>
      Effect.gen(function* () {
        for (let turn = 0; turn < TURN; turn++) {
          const outcome = yield* input.entities(partition).process(type, id, handler, processOptions);
          if (outcome._tag !== "Processed" && outcome._tag !== "Failed") return;
        }
      });

    const visit = (partition: PartitionKey) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const head of yield* input.entities(partition).due()) {
          if (head.notBefore > now) continue;
          const handler = options.handlers(head.type);
          const name = `${partition}\u0000${head.type}\u0000${head.id}`;
          if (handler === undefined || busy.has(name)) continue;
          busy.add(name);
          yield* Effect.forkScoped(permits.withPermits(1)(drain(partition, head.type, head.id, handler)).pipe(
            Effect.catchCause((cause) => Effect.logWarning(`Durable entity ${head.type}/${head.id} in ${partition} could not be processed; the next sweep tries again`, cause)),
            // Free again, the partition is looked at once more: messages sent while it was busy are taken now, not at the sweep.
            Effect.ensuring(Effect.andThen(Effect.sync(() => busy.delete(name)), PubSub.publish(input.wakes, partition))),
          ));
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`The durable entities of ${partition} could not be read; the next sweep tries again`, cause)));

    const everyPartition = Effect.gen(function* () {
      const partitions = (yield* input.partitions).filter((partition) => partition !== GLOBAL_TENANT && !isReservedTenantId(partition));
      yield* Effect.forEach(partitions, visit, { concurrency: 4, discard: true });
      return partitions;
    }).pipe(Effect.catchCause((cause) => Effect.as(Effect.logWarning("The partitions holding durable entities could not be listed", cause), [])));

    let lastPrune = 0;
    const wakes = yield* PubSub.subscribe(input.wakes);
    yield* everyPartition;
    return yield* Effect.forever(Effect.gen(function* () {
      // Every partition woken since the last turn, each once; or, after a quiet interval, a sweep of them all.
      const woke = yield* Effect.raceFirst(PubSub.takeAll(wakes), Effect.as(unrefSleep(sweepMillis), undefined));
      if (woke !== undefined) {
        yield* Effect.forEach(new Set(woke), visit, { concurrency: 4, discard: true });
        return;
      }
      const partitions = yield* everyPartition;
      const now = yield* Clock.currentTimeMillis;
      if (now - lastPrune >= 60_000) {
        lastPrune = now;
        yield* Effect.forEach(partitions, (partition) => input.entities(partition).prune({ before: now - retentionMillis }).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`Finished durable entity messages of ${partition} could not be removed; the next pass tries again`, cause)),
        ), { concurrency: 4, discard: true });
      }
    }));
  });
