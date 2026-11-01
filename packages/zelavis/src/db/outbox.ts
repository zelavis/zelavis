import { Clock, Effect, Stream } from "effect";
import { isJsonObject, isString, objectFields, parseJson } from "../core/json-validation.js";
import type { DocumentsApi, OutboxEmit } from "./document-model.js";
import { dieUnlessMoving, type IdempotencyKeyReused, InvalidMessage, MessageExists, type TenantMoving } from "./errors.js";
import type { EventCursor } from "./events.js";
import type { JsonObject } from "./json.js";
import { emptyManifest } from "./model.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import { OUTBOX_NAMESPACE } from "./tenancy.js";

/**
 * The transactional outbox: messages App code emits together with a write.
 *
 * A message is a record in the tenant's own partition, written by the same
 * transaction as the changes it accompanies (`documents.write({ emit })`), so
 * it exists exactly when they do — never a change with its message lost, never
 * a message for a change that did not happen. The tenant's log is then the
 * delivery stream: a consumer reads messages in the order they were committed,
 * from a cursor, and keeps its own place.
 *
 * Delivery is at least once. A consumer that is cut off reads a page again; a
 * backup restored into the tenant writes its messages again, at new positions.
 * Each message keeps its id through all of it, so a consumer deduplicates by
 * id, and removes the messages it has handled (`remove`) so the outbox — and,
 * once compacted, the log — holds only what is still owed.
 */

export interface OutboxMessage {
  readonly id: string;
  readonly topic: string;
  readonly payload: JsonObject;
  readonly emittedAt: string;
}

/** A message as a read finds it: with the place in the log it was committed at. */
export interface DeliveredMessage extends OutboxMessage {
  readonly cursor: EventCursor;
}

/**
 * One read of the outbox. `cursor` is where the read stopped, past entries
 * that were not messages as well as those that were; continue from it.
 * `more` says the read stopped before the end of the log.
 */
export interface OutboxPage {
  readonly messages: ReadonlyArray<DeliveredMessage>;
  readonly cursor?: EventCursor;
  readonly more: boolean;
}

export interface OutboxApi {
  /**
   * Emit one message on its own, at most once per `idempotencyKey`, and answer
   * with its id. Without an id of its own, a message emitted with a key takes
   * `idempotent:<key>`, so every replay names the one message; without either,
   * a random one.
   */
  readonly emit: (
    message: OutboxEmit & { readonly idempotencyKey?: string },
  ) => Effect.Effect<{ readonly id: string }, MessageExists | InvalidMessage | IdempotencyKeyReused | TenantMoving>;
  /**
   * Messages in the order they were committed, after `after`, up to `limit`
   * (1 to 1000, default 100) — those the outbox still holds: a removed message
   * is not read again.
   */
  readonly read: (input?: {
    readonly after?: EventCursor;
    readonly limit?: number;
    readonly topic?: string;
  }) => Effect.Effect<OutboxPage>;
  /** Remove handled messages by id, up to 1000 at a time; ids the outbox does not hold are skipped. */
  readonly remove: (input: { readonly ids: ReadonlyArray<string> }) => Effect.Effect<{ readonly removed: number }, InvalidMessage | TenantMoving>;
}

/** The longest topic or id a message may have. */
const NAME_LIMIT = 256;
/** Messages one call emits, reads or removes at most. */
const MESSAGE_LIMIT = 1000;
/** Log entries fetched per step of a read. */
const READ_STEP = 1024;
/** Log entries one read looks at before it hands back its cursor. */
const READ_SCAN_LIMIT = 4096;

const enc = new TextEncoder();
const dec = new TextDecoder();

const storedMessage = objectFields<OutboxMessage>({
  id: isString,
  topic: isString,
  payload: isJsonObject,
  emittedAt: isString,
});

const named = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= NAME_LIMIT;

/** Check a message before anything is written; the reason names what is wrong. */
export const checkEmit = (message: OutboxEmit): Effect.Effect<void, InvalidMessage> => {
  if (!named(message.topic)) {
    return Effect.fail(new InvalidMessage({ reason: `a topic must be 1 to ${NAME_LIMIT} characters` }));
  }
  if (message.id !== undefined && !named(message.id)) {
    return Effect.fail(new InvalidMessage({ reason: `an id must be 1 to ${NAME_LIMIT} characters` }));
  }
  if (!isJsonObject(message.payload)) {
    return Effect.fail(new InvalidMessage({ reason: "a payload must be a JSON object, with finite numbers only" }));
  }
  return Effect.void;
};

/** Messages with their ids and time settled, ready to record. */
export const settleMessages = (emits: ReadonlyArray<OutboxEmit>) =>
  Effect.gen(function* () {
    if (emits.length > MESSAGE_LIMIT) {
      return yield* new InvalidMessage({ reason: `a batch emits at most ${MESSAGE_LIMIT} messages` });
    }
    for (const emit of emits) yield* checkEmit(emit);
    const emittedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return emits.map((emit): OutboxMessage => ({
      id: emit.id ?? crypto.randomUUID(),
      topic: emit.topic,
      payload: emit.payload,
      emittedAt,
    }));
  });

/**
 * Record messages in the transaction that commits the changes they accompany.
 *
 * An id already in the outbox, or twice in the batch, refuses the whole
 * batch. Checked here, inside the transaction, where the partition's one
 * writer keeps the answer true until the batch lands.
 */
export const recordMessages = (store: ObjectStoreApi, txn: Txn, messages: ReadonlyArray<OutboxMessage>) =>
  Effect.gen(function* () {
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id) || (yield* store.lookup(OUTBOX_NAMESPACE, message.id)) !== undefined) {
        return yield* new MessageExists({ id: message.id });
      }
      seen.add(message.id);
      yield* txn.put(yield* txn.allocate, enc.encode(JSON.stringify(message)), emptyManifest,
        { namespace: OUTBOX_NAMESPACE, key: message.id });
    }
  });

export const outboxFor = (store: ObjectStoreApi, documents: DocumentsApi): OutboxApi => ({
  emit: (message) =>
    Effect.gen(function* () {
      yield* checkEmit(message);
      // Settled here, and from the key when there is one, so a replay is the
      // same request and names the same message.
      const id = message.id
        ?? (message.idempotencyKey === undefined ? crypto.randomUUID() : `idempotent:${message.idempotencyKey}`);
      yield* documents.write({
        operations: [],
        emit: [{ topic: message.topic, payload: message.payload, id }],
        ...(message.idempotencyKey === undefined ? {} : { idempotencyKey: message.idempotencyKey }),
      }).pipe(Effect.catchTags({
        // A batch of messages alone touches no collection, so these cannot occur.
        CollectionNotFound: Effect.die, DocumentConflict: Effect.die, DocumentNotFound: Effect.die,
        SchemaViolation: Effect.die, CheckViolation: Effect.die, UniqueViolation: Effect.die,
        ReferenceViolation: Effect.die, VectorShapeMismatch: Effect.die, InvalidDocumentValue: Effect.die,
      }));
      return { id };
    }),

  read: (input) =>
    dieUnlessMoving(store.reading(Effect.gen(function* () {
      const limit = input?.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MESSAGE_LIMIT) {
        return yield* Effect.die(new RangeError(`an outbox read takes 1 to ${MESSAGE_LIMIT} messages, not ${limit}`));
      }
      const messages: DeliveredMessage[] = [];
      // The cursor follows every entry looked at, not only the messages, and a
      // read that fills its page stops on the message that filled it.
      let cursor = input?.after;
      let scanned = 0;
      const page = (more: boolean): OutboxPage => ({ messages, ...(cursor === undefined ? {} : { cursor }), more });
      for (;;) {
        const step = yield* Stream.runCollect(
          store.events.read({ ...(cursor === undefined ? {} : { after: cursor }), limit: READ_STEP }),
        );
        for (const event of step) {
          cursor = event.cursor;
          scanned += 1;
          if (event._tag !== "ObjectPut" || event.identity?.namespace !== OUTBOX_NAMESPACE) continue;
          // Removed since it was emitted: handled, so not read again.
          if ((yield* store.read(event.seq))?.version !== event.version) continue;
          const message = parseJson(dec.decode(event.bytes), storedMessage, "outbox message");
          if (input?.topic !== undefined && message.topic !== input.topic) continue;
          messages.push({ ...message, cursor: event.cursor });
          if (messages.length >= limit) return page(true);
        }
        if (step.length < READ_STEP) return page(false);
        if (scanned >= READ_SCAN_LIMIT) return page(true);
      }
    }))).pipe(Effect.orDie),

  remove: ({ ids }) =>
    Effect.gen(function* () {
      if (!Array.isArray(ids) || ids.length > MESSAGE_LIMIT || ids.some((id) => !named(id))) {
        return yield* new InvalidMessage({ reason: `remove takes up to ${MESSAGE_LIMIT} ids of 1 to ${NAME_LIMIT} characters` });
      }
      // One transaction, so what a consumer acknowledges together goes together.
      return yield* dieUnlessMoving(store.transact((txn) =>
        Effect.gen(function* () {
          let removed = 0;
          for (const id of new Set(ids)) {
            const seq = yield* store.lookup(OUTBOX_NAMESPACE, id);
            if (seq === undefined) continue;
            yield* txn.retract(seq);
            removed += 1;
          }
          return { removed };
        })));
    }),
});
