import { parseJson } from "../core/json-validation.js";
import { consistently, documentRecord, collectionRecord } from "./documents.js";
import { Effect, Stream } from "effect";
import type { DbEvent, EventCursor } from "./events.js";
import type { Collection, Document, JsonObject } from "./documents.js";
import type { ObjectStoreApi } from "./store.js";
import { COLLECTION_NAMESPACE, DOCUMENT_NAMESPACE_PREFIX } from "./tenancy.js";
import type { TenantId } from "./topology.js";

export type DomainEventType =
  | "collection.created"
  | "collection.updated"
  | "collection.deleted"
  | "document.upserted"
  | "document.deleted";

export interface DomainEvent {
  /** Opaque; persist and return unchanged. Its position and shard are private. */
  readonly cursor: EventCursor;
  readonly eventId: string;
  readonly nodeId: string;
  readonly tenantId: TenantId;
  readonly collection: string;
  readonly documentId?: string;
  readonly type: DomainEventType;
  /** The object version this event produced. */
  readonly revision: number;
  readonly timestamp: string;
  readonly payload: JsonObject;
}

export interface ReadDomainEventsInput {
  readonly collection?: string;
  readonly documentId?: string;
  readonly after?: EventCursor;
  readonly limit?: number;
}

/** One read of a tenant's events: what matched, and where to continue. */
export interface DomainEventPage {
  readonly events: ReadonlyArray<DomainEvent>;
  /**
   * Where this read stopped; pass it back as `after`.
   *
   * It moves past every event the read looked at, matching or not. The log
   * holds more than one tenant's documents — other tenants on the shard, and
   * records that produce no domain event — so a filter can go a long stretch
   * without a match, and a continuation taken from the last match would read
   * that stretch again forever. Absent only when there was nothing to read
   * and no `after` was given.
   */
  readonly cursor?: EventCursor;
  /** The read stopped before the end of the log: reading again now may return more. */
  readonly more: boolean;
}

export interface DomainEventsApi {
  /**
   * Read this tenant's events in order.
   *
   * Read-only by design. Writes reach the log through the documents API, so
   * there is no way to append an event describing a document change that did
   * not happen — which an `append` entry point would allow.
   *
   * Bounded: one read looks at a fixed number of log entries however few of
   * them match, and says where it stopped.
   */
  readonly read: (
    input?: ReadDomainEventsInput,
  ) => Effect.Effect<DomainEventPage>;
}

/** Log entries fetched per step of a read. */
const READ_STEP = 1024;

/** Log entries one read looks at before it hands back its cursor. */
const READ_SCAN_LIMIT = 4096;

const dec = new TextDecoder();

interface Origin {
  readonly collection: string;
  readonly documentId?: string;
}

/**
 * Recover what a stored object was from the name it was written under.
 *
 * The names are the same ones the documents layer writes, so the domain event
 * stream is a reading of the object log rather than a second log kept beside
 * it. Anything under another name — a projection checkpoint, say — is internal
 * and produces no domain event. The tenant is the partition's: every record in
 * this log is the tenant's own.
 */
const originOf = (namespace: string, key: string): Origin | undefined => {
  if (namespace === COLLECTION_NAMESPACE) return { collection: key };
  if (!namespace.startsWith(DOCUMENT_NAMESPACE_PREFIX)) return undefined;
  return { collection: namespace.slice(DOCUMENT_NAMESPACE_PREFIX.length), documentId: key };
};

const isCollectionEvent = (namespace: string) => namespace === COLLECTION_NAMESPACE;

/**
 * A document or collection write as a domain event.
 *
 * `eventId` names the record and the version it reached, which is the same in
 * every place the partition is copied to — a move keeps identifiers — and
 * `nodeId` is the node that accepted the write, carried by the event itself.
 */
export const toDomainEvent = (
  event: DbEvent,
  tenant: TenantId,
): DomainEvent | undefined => {
  // A retraction carries no identity of its own; it is matched by seq to the
  // put that established it, which the caller resolves before calling here.
  if (event._tag === "ObjectPut" && event.identity === undefined) return undefined;
  if (event._tag !== "ObjectPut") return undefined;

  const origin = originOf(event.identity!.namespace, event.identity!.key);
  if (origin === undefined) return undefined;

  const collectionEvent = isCollectionEvent(event.identity!.namespace);
  const decoded = collectionEvent ? parseJson(dec.decode(event.bytes), collectionRecord) : parseJson(dec.decode(event.bytes), documentRecord);

  return {
    cursor: event.cursor,
    eventId: `${tenant}:${event.seq}:${event.version}`,
    nodeId: event.origin,
    tenantId: tenant,
    collection: origin.collection,
    ...(origin.documentId === undefined ? {} : { documentId: origin.documentId }),
    type: collectionEvent ? (event.version === 1 ? "collection.created" : "collection.updated") : "document.upserted",
    revision: event.version,
    timestamp: new Date(event.at).toISOString(),
    payload: collectionEvent
      ? ({ surface: (decoded as Collection).surface } as JsonObject)
      : ({ data: (decoded as Document).data } as JsonObject),
  };
};

export const domainEventsFor = (
  store: ObjectStoreApi,
  tenant: TenantId,
): DomainEventsApi => consistently<DomainEventsApi>(store, {
  read: (input) =>
    Effect.gen(function* () {
      // Retractions carry no namespace, so the seq of every put is remembered
      // as the log is walked and used to attribute the delete that follows.
      const origins = new Map<number, Origin>();
      const out: DomainEvent[] = [];
      const limit = input?.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return yield* Effect.die(new TypeError("limit must be an integer from 1 to 1000."));
      }

      /** The domain event one log entry is for this read, if it is one. */
      const domainEventOf = (event: DbEvent): DomainEvent | undefined => {
        if (event._tag === "ObjectPut" && event.identity !== undefined) {
          const origin = originOf(event.identity.namespace, event.identity.key);
          if (origin !== undefined) origins.set(event.seq, origin);
        }

        const origin = event._tag === "ObjectRetracted" && event.identity !== undefined
          ? originOf(event.identity.namespace, event.identity.key)
          : origins.get(event.seq);
        if (origin === undefined) return undefined;
        if (input?.collection !== undefined && origin.collection !== input.collection) return undefined;
        if (input?.documentId !== undefined && origin.documentId !== input.documentId) return undefined;

        if (event._tag === "ObjectPut") return toDomainEvent(event, tenant);
        return {
          cursor: event.cursor,
          eventId: `${tenant}:${event.seq}:${event.version}`,
          nodeId: event.origin,
          tenantId: tenant,
          collection: origin.collection,
          ...(origin.documentId === undefined ? {} : { documentId: origin.documentId }),
          type: origin.documentId === undefined ? "collection.deleted" : "document.deleted",
          revision: event.version,
          timestamp: new Date(event.at).toISOString(),
          payload: { deleted: true },
        };
      };

      // The cursor follows every entry looked at, not only the matches, and
      // a read that fills its page stops on the entry that filled it, so
      // nothing past the cursor has been looked at and skipped.
      let cursor = input?.after;
      let scanned = 0;
      const page = (more: boolean): DomainEventPage =>
        ({ events: out, ...(cursor === undefined ? {} : { cursor }), more });
      for (;;) {
        const step = yield* Stream.runCollect(
          store.events.read({ ...(cursor === undefined ? {} : { after: cursor }), limit: READ_STEP }),
        );
        for (const event of step) {
          cursor = event.cursor;
          scanned += 1;
          const domain = domainEventOf(event);
          if (domain !== undefined) out.push(domain);
          if (out.length >= limit) return page(true);
        }
        if (step.length < READ_STEP) return page(false);
        if (scanned >= READ_SCAN_LIMIT) return page(true);
      }
    }).pipe(Effect.orDie),
});
