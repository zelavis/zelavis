import { Effect } from "effect";
import type { DomainEvent, DomainEventsApi, DomainEventType } from "./domain-events.js";
import type { EventCursor } from "./events.js";
import { ProjectionNotFound } from "./errors.js";
import type { ObjectStoreApi } from "./store.js";
import type { TenantId } from "./topology.js";

export interface ProjectionSource {
  readonly collections?: ReadonlyArray<string>;
  readonly eventTypes?: ReadonlyArray<DomainEventType>;
}

export interface ProjectionDefinition {
  readonly name: string;
  readonly description?: string;
  readonly source?: ProjectionSource;
  /** Applied in log order. Must be deterministic: a rebuild replays it. */
  readonly apply: (event: DomainEvent) => Effect.Effect<void>;
  /** Discard derived state before a rebuild replays the log into it. */
  readonly reset?: () => Effect.Effect<void>;
}

export interface ProjectionSummary {
  readonly name: string;
  readonly description?: string;
  readonly sourceCollections?: ReadonlyArray<string>;
  readonly sourceEventTypes?: ReadonlyArray<DomainEventType>;
  readonly checkpoint?: EventCursor;
}

export interface ProjectionRunResult {
  readonly name: string;
  readonly applied: number;
  readonly checkpoint?: EventCursor;
}

export interface ProjectionsApi {
  readonly register: (definition: ProjectionDefinition) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectionSummary>>;
  /** Apply everything after the stored checkpoint, then advance it. */
  readonly run: (name: string) => Effect.Effect<ProjectionRunResult, ProjectionNotFound>;
  /** Discard derived state and replay the whole log into it. */
  readonly rebuild: (name: string) => Effect.Effect<ProjectionRunResult, ProjectionNotFound>;
}

/**
 * Checkpoints live in the shard whose log they track.
 *
 * That is what makes them shard-aware without any bookkeeping: a cursor is only
 * meaningful against the log that issued it, so storing it anywhere else would
 * invite comparing positions from different shards as if they were one order.
 */
/** Projections registered on a caller's behalf, listed by their own surface. */
const INTERNAL_PREFIX = "zv.";

const CHECKPOINT_NS = "zv.checkpoint";
const checkpointKey = (tenant: TenantId, name: string) => `${tenant}/${name}`;

const enc = new TextEncoder();
const dec = new TextDecoder();

const matchesSource = (definition: ProjectionDefinition, event: DomainEvent): boolean => {
  const source = definition.source;
  if (source === undefined) return true;
  if (
    source.collections !== undefined &&
    source.collections.length > 0 &&
    !source.collections.includes(event.collection)
  ) {
    return false;
  }
  if (
    source.eventTypes !== undefined &&
    source.eventTypes.length > 0 &&
    !source.eventTypes.includes(event.type)
  ) {
    return false;
  }
  return true;
};

export const projectionsFor = (
  store: ObjectStoreApi,
  events: DomainEventsApi,
  tenant: TenantId,
): ProjectionsApi => {
  const definitions = new Map<string, ProjectionDefinition>();

  const readCheckpoint = (name: string) =>
    Effect.gen(function* () {
      const seq = yield* store.lookup(CHECKPOINT_NS, checkpointKey(tenant, name));
      if (seq === undefined) return undefined;
      const object = yield* store.read(seq);
      return object === undefined
        ? undefined
        : (JSON.parse(dec.decode(object.bytes)) as { cursor: EventCursor }).cursor;
    }).pipe(Effect.orDie);

  const writeCheckpoint = (name: string, cursor: EventCursor) =>
    Effect.gen(function* () {
      const key = checkpointKey(tenant, name);
      const existing = yield* store.lookup(CHECKPOINT_NS, key);
      const seq = existing ?? (yield* store.nextSeq);
      yield* store.transact((txn) =>
        txn.put(
          seq,
          enc.encode(JSON.stringify({ cursor })),
          { terms: [], columns: [], measures: [], edges: [] },
          { namespace: CHECKPOINT_NS, key },
        ),
      );
    }).pipe(Effect.orDie);

  const drain = (definition: ProjectionDefinition, from: EventCursor | undefined) =>
    Effect.gen(function* () {
      let cursor = from;
      let applied = 0;
      for (;;) {
        const batch = yield* events.read({
          ...(cursor === undefined ? {} : { after: cursor }),
          limit: 512,
        });
        if (batch.length === 0) break;
        for (const event of batch) {
          if (matchesSource(definition, event)) {
            yield* definition.apply(event);
            applied++;
          }
          cursor = event.cursor;
        }
        // Advance once per batch rather than per event: a crash mid-batch
        // replays it, which the deterministic `apply` contract allows.
        yield* writeCheckpoint(definition.name, cursor!);
        if (batch.length < 512) break;
      }
      return { name: definition.name, applied, ...(cursor === undefined ? {} : { checkpoint: cursor }) };
    });

  const require_ = (name: string) =>
    definitions.has(name)
      ? Effect.succeed(definitions.get(name)!)
      : Effect.fail(new ProjectionNotFound({ name }));

  return {
    register: (definition) =>
      Effect.sync(() => {
        definitions.set(definition.name, definition);
      }),

    list: () =>
      Effect.forEach(
        [...definitions.values()].filter((d) => !d.name.startsWith(INTERNAL_PREFIX)),
        (definition) =>
        Effect.map(readCheckpoint(definition.name), (checkpoint) => ({
          name: definition.name,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          ...(definition.source?.collections === undefined
            ? {}
            : { sourceCollections: definition.source.collections }),
          ...(definition.source?.eventTypes === undefined
            ? {}
            : { sourceEventTypes: definition.source.eventTypes }),
          ...(checkpoint === undefined ? {} : { checkpoint }),
        })),
      ),

    run: (name) =>
      Effect.gen(function* () {
        const definition = yield* require_(name);
        return yield* drain(definition, yield* readCheckpoint(name));
      }),

    rebuild: (name) =>
      Effect.gen(function* () {
        const definition = yield* require_(name);
        if (definition.reset !== undefined) yield* definition.reset();
        return yield* drain(definition, undefined);
      }),
  } satisfies ProjectionsApi;
};
