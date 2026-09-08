import { Effect, Stream } from "effect";
import type { DbEvent, EventCursor } from "./events.js";
import type { Collection, Document, JsonObject } from "./documents.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

export type DomainEventType =
  | "collection.created"
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

export interface DomainEventsApi {
  /**
   * Read this tenant's events in order.
   *
   * Read-only by design. Writes reach the log through the documents API, so
   * there is no way to append an event describing a document change that did
   * not happen — which an `append` entry point would allow.
   */
  readonly read: (
    input?: ReadDomainEventsInput,
  ) => Effect.Effect<ReadonlyArray<DomainEvent>>;
}

const COLLECTION_PREFIX = "zv.collection/";
const DOCUMENT_PREFIX = "doc/";
const dec = new TextDecoder();

interface Origin {
  readonly tenantId: TenantId;
  readonly collection: string;
  readonly documentId?: string;
}

/**
 * Recover what a stored object was from the namespace it was written under.
 *
 * The namespaces are the same ones the documents layer writes, so the domain
 * event stream is a reading of the object log rather than a second log kept
 * beside it. Anything under another prefix — a projection checkpoint, say — is
 * internal and produces no domain event.
 */
const originOf = (namespace: string, key: string): Origin | undefined => {
  if (namespace.startsWith(COLLECTION_PREFIX)) {
    return { tenantId: namespace.slice(COLLECTION_PREFIX.length), collection: key };
  }
  if (!namespace.startsWith(DOCUMENT_PREFIX)) return undefined;
  const rest = namespace.slice(DOCUMENT_PREFIX.length);
  const split = rest.indexOf("/");
  if (split < 0) return undefined;
  return {
    tenantId: rest.slice(0, split),
    collection: rest.slice(split + 1),
    documentId: key,
  };
};

const isCollectionEvent = (namespace: string) => namespace.startsWith(COLLECTION_PREFIX);

export const toDomainEvent = (
  event: DbEvent,
  nodeId: string,
): DomainEvent | undefined => {
  // A retraction carries no identity of its own; it is matched by seq to the
  // put that established it, which the caller resolves before calling here.
  if (event._tag === "ObjectPut" && event.identity === undefined) return undefined;
  if (event._tag !== "ObjectPut") return undefined;

  const origin = originOf(event.identity!.namespace, event.identity!.key);
  if (origin === undefined) return undefined;

  const decoded = JSON.parse(dec.decode(event.bytes)) as Document | Collection;
  const collectionEvent = isCollectionEvent(event.identity!.namespace);

  return {
    cursor: event.cursor,
    eventId: `${event.partition}:${event.seq}:${event.version}`,
    nodeId,
    tenantId: origin.tenantId,
    collection: origin.collection,
    ...(origin.documentId === undefined ? {} : { documentId: origin.documentId }),
    type: collectionEvent ? "collection.created" : "document.upserted",
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
  nodeId: string,
): DomainEventsApi => ({
  read: (input) =>
    Effect.gen(function* () {
      // Retractions carry no namespace, so the seq of every put is remembered
      // as the log is walked and used to attribute the delete that follows.
      const origins = new Map<number, Origin>();
      const out: DomainEvent[] = [];
      const limit = input?.limit ?? 100;

      const raw = yield* Stream.runCollect(
        store.events.read(input?.after === undefined ? {} : { after: input.after }),
      );

      for (const event of raw) {
        if (event._tag === "ObjectPut" && event.identity !== undefined) {
          const origin = originOf(event.identity.namespace, event.identity.key);
          if (origin !== undefined) origins.set(event.seq, origin);
        }

        const origin = origins.get(event.seq);
        if (origin === undefined || origin.tenantId !== tenant) continue;
        if (input?.collection !== undefined && origin.collection !== input.collection) continue;
        if (input?.documentId !== undefined && origin.documentId !== input.documentId) continue;

        if (event._tag === "ObjectRetracted") {
          out.push({
            cursor: event.cursor,
            eventId: `${event.partition}:${event.seq}:${event.version}`,
            nodeId,
            tenantId: origin.tenantId,
            collection: origin.collection,
            ...(origin.documentId === undefined ? {} : { documentId: origin.documentId }),
            type: "document.deleted",
            revision: event.version,
            timestamp: new Date(event.at).toISOString(),
            payload: { deleted: true },
          });
        } else {
          const domain = toDomainEvent(event, nodeId);
          if (domain !== undefined) out.push(domain);
        }

        if (out.length >= limit) break;
      }

      return out;
    }).pipe(Effect.orDie),
});
