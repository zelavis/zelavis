import { Effect } from "effect";
import type { DocumentsApi } from "./documents.js";
import type { DomainEventsApi } from "./domain-events.js";
import { UnknownSystemView } from "./errors.js";
import type { JsonObject } from "./json.js";
import type { ProjectionsApi } from "./projections.js";
import type { SchemasApi } from "./schemas.js";
import type { TimeSeriesApi } from "./time-series.js";

export type SystemViewName =
  | "collections"
  | "events"
  | "schemas"
  | "projections"
  | "time-series";

export interface SystemView {
  readonly name: SystemViewName;
  readonly title: string;
  /**
   * Every view is scoped to a tenant.
   *
   * The database this replaces kept schemas, projections and time series
   * outside the tenant boundary. Here a tenant owns its own, so a view that
   * ignored the boundary would show one tenant another's definitions.
   */
  readonly tenantScoped: true;
}

export interface SystemViewRow {
  readonly id: string;
  readonly data: JsonObject;
}

export interface QuerySystemViewInput {
  readonly name: string;
  readonly limit?: number;
  /** Opaque; from a previous result's `next`. */
  readonly after?: string;
}

export interface SystemViewResult {
  readonly rows: ReadonlyArray<SystemViewRow>;
  readonly next?: string;
}

export interface SystemViewsApi {
  readonly list: () => ReadonlyArray<SystemView>;
  readonly query: (
    input: QuerySystemViewInput,
  ) => Effect.Effect<SystemViewResult, UnknownSystemView>;
}

const VIEWS: ReadonlyArray<SystemView> = Object.freeze([
  { name: "collections", title: "Collections", tenantScoped: true },
  { name: "events", title: "Events", tenantScoped: true },
  { name: "schemas", title: "Schemas", tenantScoped: true },
  { name: "projections", title: "Projections", tenantScoped: true },
  { name: "time-series", title: "Time series", tenantScoped: true },
]);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const boundedLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
};

/** Offset paging for the small listing views, kept opaque so it can change. */
const encodeOffset = (offset: number) => Buffer.from(String(offset), "utf8").toString("base64url");
const decodeOffset = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const page = (
  rows: ReadonlyArray<SystemViewRow>,
  input: QuerySystemViewInput,
): SystemViewResult => {
  const limit = boundedLimit(input.limit);
  const offset = decodeOffset(input.after);
  const slice = rows.slice(offset, offset + limit);
  return offset + slice.length < rows.length
    ? { rows: slice, next: encodeOffset(offset + slice.length) }
    : { rows: slice };
};

export interface SystemViewSources {
  readonly documents: DocumentsApi;
  readonly events: DomainEventsApi;
  readonly schemas: SchemasApi;
  readonly projections: ProjectionsApi;
  readonly timeSeries: TimeSeriesApi;
}

/**
 * The dashboard's read surface.
 *
 * Built entirely from the logical APIs, never from a store query. That is what
 * makes these views shard-aware without knowing anything about shards: a tenant
 * handle already routes to the shard holding its data, so a view cannot name a
 * physical table, cannot read one belonging to another tenant, and does not
 * break when a range is placed somewhere else.
 */
export const systemViewsFor = (sources: SystemViewSources): SystemViewsApi => ({
  list: () => VIEWS,

  query: (input) =>
    Effect.gen(function* () {
      switch (input.name) {
        case "collections": {
          const collections = yield* sources.documents.listCollections;
          return page(
            collections.map((collection) => ({
              id: collection.name,
              data: {
                name: collection.name,
                surface: collection.surface,
                createdAt: collection.createdAt,
              } as JsonObject,
            })),
            input,
          );
        }

        case "events": {
          // The event log has its own continuation, so this view forwards it
          // rather than counting rows it would have to re-read to skip.
          const limit = boundedLimit(input.limit);
          const events = yield* sources.events.read({
            ...(input.after === undefined ? {} : { after: input.after as never }),
            limit,
          });
          const rows = events.map((event) => ({
            id: event.eventId,
            data: {
              type: event.type,
              collection: event.collection,
              documentId: event.documentId ?? null,
              revision: event.revision,
              timestamp: event.timestamp,
              nodeId: event.nodeId,
            } as JsonObject,
          }));
          const last = events[events.length - 1];
          return events.length < limit || last === undefined
            ? { rows }
            : { rows, next: last.cursor as string };
        }

        case "schemas": {
          const summaries = yield* sources.schemas.listCollections;
          return page(
            summaries.map((summary) => ({
              id: summary.collection,
              data: {
                collection: summary.collection,
                activeVersion: summary.activeVersion,
                versions: [...summary.versions],
              } as JsonObject,
            })),
            input,
          );
        }

        case "projections": {
          const summaries = yield* sources.projections.list;
          return page(
            summaries.map((summary) => ({
              id: summary.name,
              data: {
                name: summary.name,
                description: summary.description ?? null,
                sourceCollections: [...(summary.sourceCollections ?? [])],
                sourceEventTypes: [...(summary.sourceEventTypes ?? [])],
                checkpoint: summary.checkpoint ?? null,
              } as JsonObject,
            })),
            input,
          );
        }

        case "time-series": {
          const summaries = yield* sources.timeSeries.list;
          return page(
            summaries.map((summary) => ({
              id: summary.name,
              data: {
                name: summary.name,
                description: summary.description ?? null,
                version: summary.version ?? null,
                bucket: summary.bucket,
              } as JsonObject,
            })),
            input,
          );
        }

        default:
          return yield* new UnknownSystemView({ name: input.name });
      }
    }),
});
