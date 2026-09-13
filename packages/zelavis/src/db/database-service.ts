import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisRuntimeService,
} from "../core/index.js";
import type { DatabaseRuntimeApi } from "./runtime-api.js";
import type {
  CollectionSurface,
  DocumentCursor,
  DocumentFilter,
  DocumentSort,
  JsonObject,
  IndexDefinition,
  IndexField,
  CheckConstraint,
  ReferenceConstraint,
  RelatedFilter,
  DocumentWrite,
  Analyzer,
  Document,
  HighlightOptions,
  SpatialFilter,
  SpatialIndex,
  EmbeddingIndex,
  EdgeDefinition,
  MeasureDefinition,
  LinkFilter,
  SimilarFilter,
  MeasureOperation,
} from "./documents.js";
import type {
  AggregateOperation,
  InterpolateInput,
  MovingInput,
  RangeInput,
  TagFilter,
  WindowsInput,
} from "./time-series.js";

function readBodyObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the Tenant a write-shaped schema request addresses. */
function tenantOf(service: DatabaseRuntimeApi, input: Record<string, unknown>) {
  return service.forTenant(readTenantId(input.tenantId));
}

function readTenantId(value: unknown): string {
  const tenantId = readString(value);
  if (!tenantId) throw new TypeError("A Tenant ID is required.");
  return tenantId;
}

const VALID_COLLECTION_SURFACES = new Set<CollectionSurface>([
  "content-studio",
  "database",
]);

function readCollectionSurface(value: unknown): CollectionSurface | undefined {
  return typeof value === "string" && VALID_COLLECTION_SURFACES.has(value as CollectionSurface)
    ? (value as CollectionSurface)
    : undefined;
}

function readJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A JSON object is required.");
  }

  return value as JsonObject;
}

const MEASURE_OPERATIONS = [
  "count", "sum", "avg", "min", "max", "variance", "stddev", "countDistinct",
] as const satisfies ReadonlyArray<MeasureOperation>;

function readMeasureOperation(value: unknown): MeasureOperation {
  const found = MEASURE_OPERATIONS.find((operation) => operation === value);
  if (found !== undefined) return found;

  // Listed from the one place that knows them; see the time-series operations.
  throw new TypeError(
    `Measure op must be one of ${MEASURE_OPERATIONS.map((operation) => `"${operation}"`).join(", ")}.`,
  );
}

function readMeasureName(value: unknown): string {
  const name = readString(value);
  if (!name) throw new TypeError("A measure name is required.");
  return name;
}

/**
 * The clauses every filtering read shares.
 *
 * Decoded in one place so a query, a page and an aggregate narrow by the same
 * words: an endpoint that read `linked` only on some of them would answer a
 * different question depending on which one was asked.
 */
function readQueryClauses(input: Record<string, unknown>) {
  return {
    where: readFilters(input.where),
    ...(Array.isArray(input.related)
      ? { related: input.related as ReadonlyArray<RelatedFilter> }
      : {}),
    ...(typeof input.search === "string" ? { search: input.search } : {}),
    ...(typeof input.fuzzy === "boolean" || typeof input.fuzzy === "number" ? { fuzzy: input.fuzzy } : {}),
    ...(typeof input.prefix === "boolean" ? { prefix: input.prefix } : {}),
    ...(typeof input.highlight === "boolean" || (input.highlight && typeof input.highlight === "object")
      ? { highlight: input.highlight as HighlightOptions | boolean }
      : {}),
    ...(input.geometry && typeof input.geometry === "object"
      ? { geometry: input.geometry as SpatialFilter }
      : {}),
    ...(input.linked && typeof input.linked === "object"
      ? { linked: input.linked as LinkFilter }
      : {}),
  };
}

function readFilters(value: unknown): DocumentFilter[] {
  return Array.isArray(value) ? (value as DocumentFilter[]) : [];
}

function readSort(value: unknown): DocumentSort[] {
  return Array.isArray(value) ? (value as DocumentSort[]) : [];
}

/** Filters carried in a query string, where a body would be the wrong shape. */
function readFilterQuery(value: string | null): DocumentFilter[] | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("precondition must be a JSON array of filters.");
  }
  if (!Array.isArray(parsed)) throw new TypeError("precondition must be a JSON array of filters.");
  return readFilters(parsed);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readQueryNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Expected an integer.");
  return parsed;
}

function readOptionalTimeSeriesBoundary(
  value: unknown,
  name: string,
): number | string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new TypeError(`${name} must be a number or non-empty string.`);
}

function readTimeSeriesOrder(value: unknown): RangeInput["order"] {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "asc" || value === "desc") {
    return value;
  }

  throw new TypeError('order must be either "asc" or "desc".');
}

const TIME_SERIES_AGGREGATE_OPERATIONS = [
  "avg", "sum", "min", "max", "count", "quantile", "first", "last", "delta", "rate",
] as const satisfies ReadonlyArray<AggregateOperation>;

function readTimeSeriesAggregateOperation(value: unknown): AggregateOperation {
  const found = TIME_SERIES_AGGREGATE_OPERATIONS.find((operation) => operation === value);
  if (found !== undefined) return found;

  // Listed from the one place that knows them, so adding an operation cannot
  // leave this message describing the set it used to accept.
  throw new TypeError(
    `Time-series aggregate op must be one of ${
      TIME_SERIES_AGGREGATE_OPERATIONS.map((operation) => `"${operation}"`).join(", ")
    }.`,
  );
}

function readRequiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a number.`);
  }

  return value;
}

function readOptionalTagFilter(value: unknown): TagFilter | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tags must be an object.");
  }

  const result: Record<string, string | ReadonlyArray<string>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      result[k] = v;
    } else if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
      result[k] = v as ReadonlyArray<string>;
    } else {
      throw new TypeError(`Tag "${k}" must be a string or array of strings.`);
    }
  }

  return result;
}

function readOptionalTimeSeriesFill(value: unknown): WindowsInput["fill"] {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "none" || value === "zero" || value === "previous" || value === "linear") {
    return value;
  }

  throw new TypeError('fill must be "none", "zero", "previous", or "linear".');
}

function readOptionalInterpolateMethod(value: unknown): InterpolateInput["method"] {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "linear" || value === "previous" || value === "next") {
    return value;
  }

  throw new TypeError('method must be "linear", "previous", or "next".');
}

function readMovingWindow(value: unknown): MovingInput["window"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("window must be an object specifying count or time.");
  }

  const obj = value as Record<string, unknown>;
  if ("count" in obj) {
    const count = obj.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
      throw new TypeError("window.count must be an integer > 0.");
    }
    return { count };
  }

  if ("time" in obj) {
    const time = obj.time;
    if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) {
      throw new TypeError("window.time must be a number > 0.");
    }
    return { time };
  }

  throw new TypeError("window must specify either count or time.");
}

function readOptionalNumberArray(value: unknown, name: string): ReadonlyArray<number> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new TypeError(`${name} must be an array of numbers.`);
  }

  return value;
}

function readOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a number.`);
  }

  return value;
}

type TaggedFailure = { readonly _tag: string } & Record<string, unknown>;

/**
 * Finds the tagged failure a rejection carries.
 *
 * The database fails in Effect's error channel with schema-tagged errors, and
 * the runtime boundary turns that channel into a rejected promise. What arrives
 * is usually the tagged error itself, but a failure crossing an extra boundary
 * can arrive wrapped, so the small set of wrappers is unwrapped here rather
 * than every route learning about them.
 */
function taggedFailureOf(error: unknown, depth = 0): TaggedFailure | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate._tag === "string") return candidate as TaggedFailure;
  return (
    taggedFailureOf(candidate.cause, depth + 1) ??
    taggedFailureOf(candidate.error, depth + 1)
  );
}

const CONFLICT_TAGS = new Set([
  "CollectionExists",
  "ConstraintExists",
  "IndexExists",
  "ReferenceViolation",
  "UniqueViolation",
  "DocumentConflict",
  "SchemaVersionExists",
]);

const NOT_FOUND_TAGS = new Set([
  "CollectionNotFound",
  "UnknownEdge",
  "UnknownMeasure",
  "DocumentNotFound",
  "ProjectionNotFound",
  "SchemaNotFound",
  "TimeSeriesNotFound",
  "UnknownReference",
  "UnknownSystemView",
]);

const BAD_REQUEST_TAGS = new Set([
  "BackupFormatUnsupported",
  "CursorMismatch",
  "UnsupportedOrdering",
  "BackupTenantMismatch",
  "CheckViolation",
  "InvalidCollectionName",
  "UnanalyzedCollection",
  "UnindexedGeometry",
  "UnembeddedCollection",
  "InvalidVectorQuery",
  "VectorShapeMismatch",
  "InvalidConstraint",
  "InvalidIndex",
  "PartitionMapInvalid",
  "RangeNotEmpty",
  "SchemaViolation",
  "TenantNotEmpty",
]);

/**
 * A caller-facing sentence for a tagged failure.
 *
 * A schema-tagged error carries structured fields and an empty `message`, and
 * a 4xx body is the useful half of an API, so the fields are rendered here
 * rather than shipping `{"error": ""}` to whoever made the request.
 */
function describeTaggedFailure(failure: TaggedFailure): string {
  switch (failure._tag) {
    case "CollectionExists":
      return `Collection "${failure.name}" already exists.`;
    case "CollectionNotFound":
      return `Collection "${failure.name}" does not exist.`;
    case "InvalidCollectionName":
      return `Collection name "${failure.name}" is invalid: ${failure.reason}.`;
    case "DocumentNotFound":
      return `Document "${failure.id}" does not exist in collection "${failure.collection}".`;
    case "DocumentConflict":
      return `Document "${failure.id}" in collection "${failure.collection}" conflicts: ${failure.reason}.`;
    case "ProjectionNotFound":
      return `Projection "${failure.name}" is not defined.`;
    case "SchemaVersionExists":
      return `Schema version ${failure.version} for collection "${failure.collection}" already exists.`;
    case "SchemaNotFound":
      return `Schema version ${failure.version} for collection "${failure.collection}" does not exist.`;
    case "SchemaViolation": {
      const issues = Array.isArray(failure.issues)
        ? (failure.issues as ReadonlyArray<{ path: string; message: string }>)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ")
        : "";
      return `Document does not satisfy schema version ${failure.schemaVersion} of collection "${failure.collection}"${issues ? `: ${issues}` : "."}`;
    }
    case "TimeSeriesNotFound":
      return `Time series "${failure.name}" is not defined.`;
    case "UnindexedGeometry":
      return `Collection "${failure.collection}" does not index geometry at "${failure.field}".`;
    case "UnanalyzedCollection":
      return `Collection "${failure.collection}" has no analyzer, so it has nothing to search.`;
    case "UnknownReference":
      return `Collection "${failure.collection}" has no reference named "${failure.name}".`;
    case "UnknownSystemView":
      return `Unknown logical database system view "${failure.name}".`;
    case "BackupTenantMismatch":
      return `This backup belongs to Tenant "${failure.received}", not "${failure.expected}".`;
    case "BackupFormatUnsupported":
      return `Unsupported backup format "${failure.format}".`;
    case "TenantNotEmpty":
      return `Tenant "${failure.tenant}" already holds data; restoring would orphan it.`;
    case "PartitionMapInvalid":
      return `Partition map version ${failure.version} is invalid: ${failure.reason}.`;
    case "RangeNotEmpty":
      return `Range ${failure.range} cannot move from "${failure.from}" to "${failure.to}" while tenants stand on it.`;
    case "CursorMismatch":
      return `This cursor cannot continue the read: ${failure.reason}.`;
    case "UnsupportedOrdering":
      return `This order is not supported: ${failure.reason}.`;
    case "InvalidIndex":
      return `Index "${failure.name}" on collection "${failure.collection}" is invalid: ${failure.reason}.`;
    case "IndexExists":
      return `Collection "${failure.collection}" already has an index named "${failure.name}": ${failure.reason}.`;
    case "UniqueViolation":
      return `Document "${failure.id}" in collection "${failure.collection}" repeats the values index "${failure.index}" holds for "${failure.holder}".`;
    case "CheckViolation":
      return `Document "${failure.id}" in collection "${failure.collection}" fails check "${failure.check}": ${failure.reason}.`;
    case "ReferenceViolation":
      return `Document "${failure.id}" in collection "${failure.collection}" breaks reference "${failure.reference}": ${failure.reason}.`;
    case "InvalidConstraint":
      return `Constraint "${failure.name}" on collection "${failure.collection}" is invalid: ${failure.reason}.`;
    case "ConstraintExists":
      return `Collection "${failure.collection}" already has a constraint named "${failure.name}".`;
    default:
      return failure._tag;
  }
}

const databaseErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) => error instanceof TypeError,
    status: 400,
  },
  {
    matches: (error) => CONFLICT_TAGS.has(taggedFailureOf(error)?._tag ?? ""),
    status: 409,
  },
  {
    matches: (error) => NOT_FOUND_TAGS.has(taggedFailureOf(error)?._tag ?? ""),
    status: 404,
  },
  {
    matches: (error) => BAD_REQUEST_TAGS.has(taggedFailureOf(error)?._tag ?? ""),
    status: 400,
  },
];

function databaseErrorResponse(error: unknown, fallback = 500) {
  const failure = taggedFailureOf(error);
  return createMappedJsonErrorResponse(
    failure ? Object.assign(new Error(describeTaggedFailure(failure)), { _tag: failure._tag }) : error,
    databaseErrorRules,
    fallback,
  );
}

export type DatabaseServiceDefinition = ZelavisRuntimeService<DatabaseRuntimeApi>;

export function defineDatabaseService(
  database: DatabaseRuntimeApi,
): DatabaseServiceDefinition {
  return {
    name: "@zelavis/db",
    kind: "plugin" as const,
    basePath: "database",
    menu: {
      title: "Database",
      path: "/database",
      surface: "core",
      panelLabel: "Database",
      dynamicItems: {
        path: "/database/menu/tables?tenantId=zelavis-app",
        emptyTitle: "No tables yet",
      },
      items: [
        {
          title: "Create Table",
          path: "/database/new",
          pageLabel: "Database",
          fixed: true,
          fixedOrder: 1,
        },
      ],
    },
    service: database,
    api: {
      v1: [
        {
          id: "database.menu.tables",
          spec: {
            operationId: "listDatabaseTablesMenu",
            summary: "List tables as dashboard menu items",
            tags: ["database"],
            responses: {
              200: { description: "Menu items" },
            },
          },
          method: "GET",
          path: "/menu/tables",
          handler: async ({ service, query }) => {
            const tenantId = readTenantId(query.get("tenantId"));
            const collections = await service
              .forTenant(tenantId)
              .documents.listCollections();

            return {
              body: {
                items: [
                  ...[...collections]
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((collection) => ({
                    title: collection.name,
                    path: "/database",
                    pageLabel: "Database",
                    search: { databaseTable: collection.name },
                  })),
                  ...service.forTenant(tenantId).systemViews.list().map((view) => ({
                    title: `System · ${view.title}`,
                    path: "/database",
                    pageLabel: "Database",
                    search: { databaseSystemView: view.name },
                  })),
                ],
              },
            };
          },
        },
        {
          id: "database.health",
          method: "GET",
          path: "/health",
          spec: {
            operationId: "healthCheck",
            summary: "Database health check",
            tags: ["database"],
            responses: {
              200: { description: "Health check response" },
            },
          },
          // Shard count and partition-map version are the two facts an operator
          // needs to tell one topology from another, and they are honest only
          // now that a real sharded database answers this route.
          handler: ({ service }) => ({
            body: {
              status: "ok",
              nodeId: service.context.nodeId,
              shards: service.topology.shards.length,
              virtualRanges: service.topology.virtualRanges,
              partitionMapVersion: service.topology.partitionMapVersion,
            },
          }),
        },
      ],
    },
    services: [
      defineDatabaseDocumentsService(database),
      defineDatabaseSchemasService(database),
      defineDatabaseTimeSeriesService(database),
      defineDatabaseMaintenanceService(database),
    ],
  };
}

export function defineDatabaseMaintenanceService(
  database: DatabaseRuntimeApi,
): ZelavisRuntimeService<DatabaseRuntimeApi> {
  return {
    name: "maintenance",
    basePath: "maintenance",
    service: database,
    api: {
      v1: [
        {
          id: "database.system-views.list",
          spec: {
            operationId: "listDatabaseSystemViews",
            summary: "List the maintenance views this database exposes",
            tags: ["database"],
            responses: {
              200: { description: "Views" },
            },
          },
          method: "GET",
          path: "/system/views",
          access: { permissions: ["database.inspect"] },
          handler: ({ service, query }) => ({
            body: {
              views: service
                .forTenant(readTenantId(query.get("tenantId")))
                .systemViews.list(),
            },
          }),
        },
        {
          id: "database.system-views.query",
          spec: {
            operationId: "queryDatabaseSystemView",
            summary: "Read one maintenance view",
            tags: ["database"],
            responses: {
              200: { description: "Rows" },
              404: { description: "No such view" },
            },
          },
          method: "GET",
          path: "/system/views/:view",
          access: { permissions: ["database.inspect"] },
          handler: async ({ service, params, query }) => {
            try {
              return {
                body: await service
                  .forTenant(readTenantId(query.get("tenantId")))
                  .systemViews.query({
                  name: params.view,
                  limit: readQueryNumber(query.get("limit")),
                  after: query.get("after") ?? undefined,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.rewrite",
          method: "POST",
          path: "/documents/rewrite",
          spec: {
            operationId: "rewriteDocuments",
            summary: "Write documents back so their postings match today's lenses",
            tags: ["database"],
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  collection: { type: "string", description: "One collection; every one when omitted" },
                },
              },
            },
            responses: {
              200: { description: "How many collections and documents were written back" },
              400: { description: "Bad request" },
              404: { description: "No such collection" },
            },
          },
          handler: async ({ service, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service.forTenant(tenantId).documents.rewrite(
                  typeof input.collection === "string" ? { collection: input.collection } : undefined,
                ),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.backups.export",
          spec: {
            operationId: "exportDatabaseBackup",
            summary: "Export a database backup",
            tags: ["database"],
            responses: {
              200: { description: "Backup exported" },
              400: { description: "Export failed" },
            },
          },
          method: "POST",
          path: "/backups/export",
          access: { permissions: ["database.backup"] },
          handler: async ({ service, body }) => {
            try {
              const input = readBodyObject(body);
              return {
                body: await tenantOf(service, input).backups.exportTenant(),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.backups.restore",
          spec: {
            operationId: "restoreDatabaseBackup",
            summary: "Restore a database backup",
            tags: ["database"],
            responses: {
              200: { description: "Backup restored" },
              400: { description: "Restore failed" },
            },
          },
          method: "POST",
          path: "/backups/restore",
          access: { permissions: ["database.restore"] },
          handler: async ({ service, body }) => {
            try {
              const input = readBodyObject(body);
              if (!input.backup || typeof input.backup !== "object" || Array.isArray(input.backup)) {
                throw new TypeError("A database backup object is required.");
              }
              const backup = input.backup as { tenantId?: unknown };
              // Restore is reached through the Tenant now, so the request has
              // to name one. A caller that states it keeps the mismatch guard
              // meaningful; one that does not gets the Tenant the backup was
              // taken from, which is what the replaced route did.
              return {
                body: await service
                  .forTenant(readTenantId(input.tenantId ?? backup.tenantId))
                  .backups.restoreTenant(backup as never),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  };
}

export function defineDatabaseDocumentsService(
  database: DatabaseRuntimeApi,
): ZelavisRuntimeService<DatabaseRuntimeApi> {
  return {
    name: "documents",
    basePath: "documents",
    service: database,
    api: {
      v1: [
        {
          id: "database.collections.list",
          method: "GET",
          path: "/collections",
          spec: {
            operationId: "listCollections",
            summary: "List collections",
            tags: ["database"],
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "List of collections" },
              400: { description: "Bad request" },
            },
          },
          handler: async ({ service, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  collections: await service
                    .forTenant(tenantId)
                    .documents.listCollections(),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.collections.create",
          method: "POST",
          path: "/collections",
          spec: {
            operationId: "createCollection",
            summary: "Create a collection",
            tags: ["database"],
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["name", "tenantId"],
                properties: {
                  name: { type: "string" },
                  tenantId: { type: "string" },
                  surface: { type: "string" },
                  metadata: { type: "object", additionalProperties: true },
                  indexes: { type: "array", description: "Composite indexes, each { name, fields, unique? }" },
                  checks: { type: "array", description: "Check constraints, each { name, where }" },
                  references: { type: "array", description: "References, each { name, path, collection, onDelete? }" },
                  analyzer: { type: "object", description: "How text becomes terms: { fields, version, ... }" },
                  spatial: { type: "object", description: "How geometry becomes cells: { fields, resolution, version }" },
                  embedding: { type: "object", description: "Which field holds a vector: { field, dimension, metric, version }" },
                  edges: { type: "array", description: "Typed links, each { name, path, collection }" },
                  measures: { type: "array", description: "Numeric fields to aggregate, each { name, path }" },
                },
              },
            },
            responses: {
              201: { description: "Collection created" },
              400: { description: "Bad request" },
              409: { description: "Conflict" },
            },
          },
          handler: async ({ service, body }) => {
            const input = readBodyObject(body);
            const name = readString(input.name);
            if (!name) {
              return {
                status: 400,
                body: {
                  error: "A collection name is required.",
                },
              };
            }

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                status: 201,
                body: await service.forTenant(tenantId).documents.createCollection({
                  name,
                  surface: readCollectionSurface(input.surface),
                  metadata:
                    input.metadata &&
                    typeof input.metadata === "object" &&
                    !Array.isArray(input.metadata)
                      ? (input.metadata as Record<string, unknown>)
                      : undefined,
                  indexes: Array.isArray(input.indexes)
                    ? (input.indexes as ReadonlyArray<IndexDefinition>)
                    : undefined,
                  checks: Array.isArray(input.checks)
                    ? (input.checks as ReadonlyArray<CheckConstraint>)
                    : undefined,
                  references: Array.isArray(input.references)
                    ? (input.references as ReadonlyArray<ReferenceConstraint>)
                    : undefined,
                  analyzer: input.analyzer && typeof input.analyzer === "object"
                    ? (input.analyzer as Analyzer)
                    : undefined,
                  spatial: input.spatial && typeof input.spatial === "object"
                    ? (input.spatial as SpatialIndex)
                    : undefined,
                  embedding: input.embedding && typeof input.embedding === "object"
                    ? (input.embedding as EmbeddingIndex)
                    : undefined,
                  edges: Array.isArray(input.edges)
                    ? (input.edges as ReadonlyArray<EdgeDefinition>)
                    : undefined,
                  measures: Array.isArray(input.measures)
                    ? (input.measures as ReadonlyArray<MeasureDefinition>)
                    : undefined,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 409);
            }
          },
        },
        {
          id: "database.documents.write",
          method: "POST",
          path: "/write",
          spec: {
            operationId: "writeDocuments",
            summary: "Apply several document changes as one",
            tags: ["documents"],
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "operations"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  operations: {
                    type: "array",
                    description: "Changes, each { _tag: Insert | Update | Delete, collection, ... }",
                  },
                },
              },
            },
            responses: {
              200: { description: "What each change did, in the order asked" },
              400: { description: "A change nothing allows, which refuses the whole batch" },
              404: { description: "Not found" },
              409: { description: "A conflict, which refuses the whole batch" },
            },
          },
          handler: async ({ service, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              if (!Array.isArray(input.operations)) {
                throw new TypeError("operations must be a list of changes.");
              }
              return {
                body: {
                  written: await service.forTenant(tenantId).documents.write({
                    operations: input.operations as ReadonlyArray<DocumentWrite>,
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.insert",
          method: "POST",
          path: "/:collection",
          spec: {
            operationId: "insertDocument",
            summary: "Insert a document into a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "data"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  id: { type: "string", description: "Optional document ID" },
                  data: { type: "object", additionalProperties: true, description: "Document data" },
                },
              },
            },
            responses: {
              201: { description: "Document created successfully" },
              400: { description: "Validation error" },
              409: { description: "Conflict or revision mismatch" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                status: 201,
                body: await service.forTenant(tenantId).documents.insert({
                  collection: params.collection,
                  id: readString(input.id),
                  data: readJsonObject(input.data),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.get",
          method: "GET",
          path: "/:collection/:id",
          spec: {
            operationId: "getDocument",
            summary: "Get document by ID",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
              id: { type: "string", required: true, description: "Document ID" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "Document retrieved successfully" },
              400: { description: "Validation error" },
              404: { description: "Document not found" },
            },
          },
          handler: async ({ service, params, query }) => {
            let document;
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              document = await service.forTenant(tenantId).documents.findById({
                collection: params.collection,
                id: params.id,
              });
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }

            if (!document) {
              return {
                status: 404,
                body: {
                  error: "Document not found.",
                },
              };
            }

            return { body: document };
          },
        },
        {
          id: "database.documents.query",
          method: "POST",
          path: "/:collection/query",
          spec: {
            operationId: "queryDocuments",
            summary: "Query documents",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  where: { type: "array", description: "Filters" },
                  related: { type: "array", description: "Joins, each { reference, where?, id? }" },
                  search: { type: "string", description: "Words, prefixes (comput*), fuzzy terms (macbok~), or quoted \"phrases\" to find in analyzed fields, ranked by BM25 relevance" },
                  fuzzy: { description: "When true or edit distance (1 or 2), terms match fuzzily within edit distance" },
                  prefix: { type: "boolean", description: "When true, terms match as prefixes (search-as-you-type)" },
                  highlight: { description: "When true or HighlightOptions, highlights matching terms in analyzed fields" },
                  geometry: { type: "object", description: "A spatial filter: { field, near+radius | within | intersects }" },
                  linked: { type: "object", description: "Only what a document links to or what links to it: { collection, id, edge, direction? }" },
                  similar: { type: "object", description: "Closest first by embedding: { field, vector, k }" },
                  orderBy: { type: "array", description: "Sorts" },
                  limit: { type: "number" },
                  offset: { type: "number" },
                },
              },
            },
            responses: {
              200: { description: "Query results" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  documents: await service.forTenant(tenantId).documents.findMany({
                    collection: params.collection,
                    ...readQueryClauses(input),
                    ...(input.similar && typeof input.similar === "object"
                      ? { similar: input.similar as SimilarFilter }
                      : {}),
                    orderBy: readSort(input.orderBy),
                    limit: readNumber(input.limit, 100),
                    offset: readNumber(input.offset, 0),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.page",
          method: "POST",
          path: "/:collection/page",
          spec: {
            operationId: "pageDocuments",
            summary: "Page through documents in order",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  where: { type: "array", description: "Filters" },
                  related: { type: "array", description: "Joins, each { reference, where?, id? }" },
                  search: { type: "string", description: "Words, prefixes (comput*), fuzzy terms (macbok~), or quoted \"phrases\" to find in the analyzed fields" },
                  fuzzy: { description: "When true or edit distance (1 or 2), terms match fuzzily within edit distance" },
                  prefix: { type: "boolean", description: "When true, terms match as prefixes (search-as-you-type)" },
                  highlight: { description: "When true or HighlightOptions, highlights matching terms in analyzed fields" },
                  geometry: { type: "object", description: "A spatial filter: { field, near+radius | within | intersects }" },
                  linked: { type: "object", description: "Only what a document links to or what links to it: { collection, id, edge, direction? }" },
                  orderBy: { type: "array", description: "One field, or several that a composite index serves" },
                  limit: { type: "number", description: "Documents per page: 1 to 1000, 50 when omitted" },
                  after: { type: "string", description: "The next cursor from the previous page" },
                },
              },
            },
            responses: {
              200: { description: "One page, and a next cursor only when more documents follow" },
              400: { description: "A cursor from another read, an order no index serves, or a bad limit" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              const limit = readNumber(input.limit, 50);
              if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
                throw new TypeError("limit must be an integer from 1 to 1000.");
              }
              if (input.after !== undefined && typeof input.after !== "string") {
                throw new TypeError("after must be the next cursor from a previous page.");
              }
              return {
                body: await service.forTenant(tenantId).documents.findPage({
                  collection: params.collection,
                  ...readQueryClauses(input),
                  orderBy: readSort(input.orderBy),
                  limit,
                  ...(input.after === undefined ? {} : { after: input.after as DocumentCursor }),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.traverse",
          method: "POST",
          path: "/:collection/traverse",
          spec: {
            operationId: "traverseDocuments",
            summary: "Bounded breadth-first traversal along declared graph edges",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name of starting document" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "id", "edge"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  id: { type: "string", description: "Starting document ID" },
                  edge: { type: "string", description: "Edge name to traverse" },
                  edgeCollection: { type: "string", description: "Collection that declares the edge (optional)" },
                  direction: { type: "string", enum: ["outbound", "inbound", "both"], description: "Traversal direction" },
                  maxDepth: { type: "number", description: "Maximum traversal depth (default: 1, max: 20)" },
                  maxVisits: { type: "number", description: "Maximum documents to visit (default: 100, max: 1000)" },
                  where: { type: "array", description: "Filters applied to traversed documents" },
                },
              },
            },
            responses: {
              200: { description: "Traversed documents and traversal steps" },
              404: { description: "Not found or unknown edge" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service.forTenant(tenantId).documents.traverse({
                  collection: params.collection,
                  id: String(input.id ?? ""),
                  edge: String(input.edge ?? ""),
                  ...(typeof input.edgeCollection === "string" ? { edgeCollection: input.edgeCollection } : {}),
                  ...(input.direction === "outbound" || input.direction === "inbound" || input.direction === "both"
                    ? { direction: input.direction }
                    : {}),
                  ...(typeof input.maxDepth === "number" ? { maxDepth: input.maxDepth } : {}),
                  ...(typeof input.maxVisits === "number" ? { maxVisits: input.maxVisits } : {}),
                  ...(Array.isArray(input.where) ? { where: readFilters(input.where) } : {}),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.summarize",
          method: "POST",
          path: "/:collection/summarize",
          spec: {
            operationId: "summarizeDocuments",
            summary: "Aggregate a declared measure",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "measure", "op"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  measure: { type: "string", description: "A measure the collection declares" },
                  op: { type: "string", description: "count, sum, avg, min, max, variance, stddev or countDistinct" },
                  where: { type: "array", description: "Filters" },
                  related: { type: "array", description: "Joins, each { reference, where?, id? }" },
                  search: { type: "string", description: "Words or quoted \"phrases\" to find in the analyzed fields" },
                  geometry: { type: "object", description: "A spatial filter" },
                  linked: { type: "object", description: "Only what a document links to or what links to it: { collection, id, edge, direction? }" },
                },
              },
            },
            responses: {
              200: { description: "The value, and the documents it was computed over" },
              400: { description: "An operation or measure the collection cannot answer" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service.forTenant(tenantId).documents.summarize({
                  collection: params.collection,
                  measure: readMeasureName(input.measure),
                  op: readMeasureOperation(input.op),
                  ...readQueryClauses(input),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.summarizeBy",
          method: "POST",
          path: "/:collection/summarize-by",
          spec: {
            operationId: "summarizeDocumentsBy",
            summary: "Aggregate a declared measure, grouped",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "measure", "op", "groupBy"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  measure: { type: "string", description: "A measure the collection declares" },
                  op: { type: "string", description: "count, sum, avg, min, max, variance, stddev or countDistinct" },
                  groupBy: { type: "string", description: "The field whose values separate the groups" },
                  groups: { type: "number", description: "Groups to return: 100 when omitted, at most 1000" },
                  where: { type: "array", description: "Filters" },
                  related: { type: "array", description: "Joins, each { reference, where?, id? }" },
                  search: { type: "string", description: "Words or quoted \"phrases\" to find in the analyzed fields" },
                  geometry: { type: "object", description: "A spatial filter" },
                  linked: { type: "object", description: "Only what a document links to or what links to it: { collection, id, edge, direction? }" },
                },
              },
            },
            responses: {
              200: { description: "One answer per value at the grouped field" },
              400: { description: "An operation or measure the collection cannot answer" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              const groupBy = readString(input.groupBy);
              if (!groupBy) throw new TypeError("A field to group by is required.");
              return {
                body: {
                  groups: await service.forTenant(tenantId).documents.summarizeBy({
                    collection: params.collection,
                    measure: readMeasureName(input.measure),
                    op: readMeasureOperation(input.op),
                    groupBy,
                    ...(input.groups === undefined
                      ? {}
                      : { groups: readRequiredNumber(input.groups, "groups") }),
                    ...readQueryClauses(input),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.collections.exists",
          method: "GET",
          path: "/collections/:collection/exists",
          spec: {
            operationId: "collectionExists",
            summary: "Whether a collection exists",
            tags: ["database"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "Whether the collection exists" },
              400: { description: "Bad request" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  exists: await service.forTenant(tenantId).documents.collectionExists(params.collection),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.related",
          method: "POST",
          path: "/:collection/related",
          spec: {
            operationId: "withRelated",
            summary: "Resolve the documents these documents reference",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "documents"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  documents: { type: "array", description: "Documents whose references to resolve" },
                  references: { type: "array", description: "Which references; every declared one when omitted" },
                },
              },
            },
            responses: {
              200: { description: "Each document, and what its references name" },
              404: { description: "A reference the collection does not declare" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  documents: await service.forTenant(tenantId).documents.withRelated({
                    collection: params.collection,
                    documents: Array.isArray(input.documents)
                      ? (input.documents as ReadonlyArray<Document>)
                      : [],
                    ...(Array.isArray(input.references)
                      ? { references: input.references as ReadonlyArray<string> }
                      : {}),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.analyzer",
          method: "POST",
          path: "/:collection/analyzer",
          spec: {
            operationId: "analyzeCollection",
            summary: "Declare how a collection's text becomes terms, and rewrite under it",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "analyzer"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  analyzer: { type: "object", description: "{ fields, version, fold?, stopWords?, minLength?, language? }" },
                },
              },
            },
            responses: {
              200: { description: "The analyzer, and how many documents were rewritten" },
              400: { description: "An analyzer that cannot be used" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              if (!input.analyzer || typeof input.analyzer !== "object") {
                throw new TypeError("An analyzer is required.");
              }
              return {
                body: await service.forTenant(tenantId).documents.analyze({
                  collection: params.collection,
                  analyzer: input.analyzer as Analyzer,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.geometry",
          method: "POST",
          path: "/:collection/geometry",
          spec: {
            operationId: "locateCollection",
            summary: "Declare how a collection's geometry becomes cells, and rewrite under it",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "spatial"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  spatial: { type: "object", description: "{ fields, resolution, version }" },
                },
              },
            },
            responses: {
              200: { description: "The spatial index, and how many documents were rewritten" },
              400: { description: "An index that cannot be used" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              if (!input.spatial || typeof input.spatial !== "object") {
                throw new TypeError("A spatial index is required.");
              }
              return {
                body: await service.forTenant(tenantId).documents.locate({
                  collection: params.collection,
                  spatial: input.spatial as SpatialIndex,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.embedding",
          method: "POST",
          path: "/:collection/embedding",
          spec: {
            operationId: "embedCollection",
            summary: "Declare which field holds an embedding, and hold the collection to it",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "embedding"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  embedding: { type: "object", description: "{ field, dimension, metric, version, normalize?, model? }" },
                },
              },
            },
            responses: {
              200: { description: "The embedding, and how many documents were read against it" },
              400: { description: "A declaration its own documents fail, or one that cannot be used" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              if (!input.embedding || typeof input.embedding !== "object") {
                throw new TypeError("An embedding is required.");
              }
              return {
                body: await service.forTenant(tenantId).documents.embed({
                  collection: params.collection,
                  embedding: input.embedding as EmbeddingIndex,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.indexes.create",
          method: "POST",
          path: "/:collection/indexes",
          spec: {
            operationId: "createIndex",
            summary: "Add a composite index to a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "name", "fields"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  name: { type: "string", description: "Index name" },
                  fields: { type: "array", description: "Fields in order, each { path, direction?, nulls? }" },
                },
              },
            },
            responses: {
              201: { description: "The index, ready to answer reads" },
              400: { description: "An index definition that cannot be built" },
              404: { description: "Not found" },
              409: { description: "The name is taken by an index over other fields" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                status: 201,
                body: await service.forTenant(tenantId).documents.createIndex({
                  collection: params.collection,
                  name: typeof input.name === "string" ? input.name : "",
                  fields: Array.isArray(input.fields) ? (input.fields as ReadonlyArray<IndexField>) : [],
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.indexes.drop",
          method: "DELETE",
          path: "/:collection/indexes/:name",
          spec: {
            operationId: "dropIndex",
            summary: "Remove a composite index from a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
              name: { type: "string", required: true, description: "Index name" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "Whether an index by that name was removed" },
              400: { description: "Bad request" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  dropped: await service.forTenant(tenantId).documents.dropIndex({
                    collection: params.collection,
                    name: params.name,
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.checks.add",
          method: "POST",
          path: "/:collection/checks",
          spec: {
            operationId: "addCheck",
            summary: "Add a check constraint to a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "name", "where"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  name: { type: "string", description: "Check name" },
                  where: { type: "array", description: "Filters every document must satisfy" },
                },
              },
            },
            responses: {
              201: { description: "The check, which every document satisfies" },
              400: { description: "A definition that cannot be enforced, or a document that fails it" },
              404: { description: "Not found" },
              409: { description: "The name is taken" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                status: 201,
                body: await service.forTenant(tenantId).documents.addCheck({
                  collection: params.collection,
                  name: typeof input.name === "string" ? input.name : "",
                  where: readFilters(input.where),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.checks.drop",
          method: "DELETE",
          path: "/:collection/checks/:name",
          spec: {
            operationId: "dropCheck",
            summary: "Remove a check constraint from a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
              name: { type: "string", required: true, description: "Check name" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "Whether a check by that name was removed" },
              400: { description: "Bad request" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  dropped: await service.forTenant(tenantId).documents.dropCheck({
                    collection: params.collection,
                    name: params.name,
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.references.add",
          method: "POST",
          path: "/:collection/references",
          spec: {
            operationId: "addReference",
            summary: "Add a reference from a collection to another",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "The collection holding the field" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "name", "path", "collection"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  name: { type: "string", description: "Reference name" },
                  path: { type: "string", description: "The field holding the id" },
                  collection: { type: "string", description: "The collection the id names a document of" },
                  onDelete: { type: "string", description: "restrict, cascade or set-null" },
                },
              },
            },
            responses: {
              201: { description: "The reference, which every document satisfies" },
              400: { description: "A definition that cannot be enforced" },
              404: { description: "Not found" },
              409: { description: "The name is taken, or a document names nothing" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                status: 201,
                body: await service.forTenant(tenantId).documents.addReference({
                  from: params.collection,
                  name: typeof input.name === "string" ? input.name : "",
                  path: typeof input.path === "string" ? input.path : "",
                  collection: typeof input.collection === "string" ? input.collection : "",
                  ...(typeof input.onDelete === "string"
                    ? { onDelete: input.onDelete as ReferenceConstraint["onDelete"] }
                    : {}),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.references.drop",
          method: "DELETE",
          path: "/:collection/references/:name",
          spec: {
            operationId: "dropReference",
            summary: "Remove a reference from a collection",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "The collection holding the field" },
              name: { type: "string", required: true, description: "Reference name" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "Whether a reference by that name was removed" },
              400: { description: "Bad request" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  dropped: await service.forTenant(tenantId).documents.dropReference({
                    collection: params.collection,
                    name: params.name,
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.documents.update",
          method: "PATCH",
          path: "/:collection/:id",
          spec: {
            operationId: "updateDocument",
            summary: "Update document",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
              id: { type: "string", required: true, description: "Document ID" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "data"],
                properties: {
                  tenantId: { type: "string", description: "Tenant ID" },
                  data: { type: "object", additionalProperties: true, description: "Document data" },
                  mode: { type: "string", description: "Update mode (merge or replace)" },
                  expectedVersion: { type: "number", description: "The version the document must be at" },
                  precondition: { type: "array", description: "Filters the document must match as it stands" },
                },
              },
            },
            responses: {
              200: { description: "Document updated" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service.forTenant(tenantId).documents.update({
                  collection: params.collection,
                  id: params.id,
                  data: readJsonObject(input.data),
                  mode: input.mode === "replace" ? "replace" : "merge",
                  ...(typeof input.expectedVersion === "number" ? { expectedVersion: input.expectedVersion } : {}),
                  ...(Array.isArray(input.precondition) ? { precondition: readFilters(input.precondition) } : {}),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.documents.delete",
          method: "DELETE",
          path: "/:collection/:id",
          spec: {
            operationId: "deleteDocument",
            summary: "Delete document",
            tags: ["documents"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
              id: { type: "string", required: true, description: "Document ID" },
            },
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
              expectedVersion: { type: "number", description: "The version the document must be at" },
              precondition: {
                type: "string",
                description: "Filters the document must match, as a JSON array",
              },
            },
            responses: {
              200: { description: "Document deleted" },
              400: { description: "Bad request" },
              409: { description: "The document is not as the caller expected" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              const expectedVersion = readQueryNumber(query.get("expectedVersion"));
              const precondition = readFilterQuery(query.get("precondition"));
              return {
                body: {
                  deleted: await service.forTenant(tenantId).documents.delete({
                    collection: params.collection,
                    id: params.id,
                    ...(expectedVersion === undefined ? {} : { expectedVersion }),
                    ...(precondition === undefined ? {} : { precondition }),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  };
}

export function defineDatabaseSchemasService(
  database: DatabaseRuntimeApi,
): ZelavisRuntimeService<DatabaseRuntimeApi> {
  return {
    name: "schemas",
    basePath: "schemas",
    service: database,
    api: {
      v1: [
        {
          id: "database.schemas.list",
          method: "GET",
          path: "/collections",
          spec: {
            operationId: "listSchemas",
            summary: "List schema collections",
            tags: ["schemas"],
            responses: {
              200: { description: "List of schemas" },
            },
          },
          handler: async ({ service, query }) => ({
            body: {
              collections: await service
                .forTenant(readTenantId(query.get("tenantId")))
                .schemas.listCollections(),
            },
          }),
        },
        {
          id: "database.schemas.versions.list",
          method: "GET",
          path: "/:collection",
          spec: {
            operationId: "listSchemaVersions",
            summary: "List schema versions for a collection",
            tags: ["schemas"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            responses: {
              200: { description: "List of schema versions" },
            },
          },
          handler: async ({ service, params, query }) => ({
            body: {
              collection: params.collection,
              schemas: await service
                .forTenant(readTenantId(query.get("tenantId")))
                .schemas.listVersions(params.collection),
            },
          }),
        },
        {
          id: "database.schemas.save",
          method: "POST",
          path: "/:collection",
          spec: {
            operationId: "saveSchema",
            summary: "Save a schema",
            tags: ["schemas"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["version", "fields"],
                properties: {
                  version: { type: "number" },
                  activate: { type: "boolean" },
                  fields: { type: "array" },
                },
              },
            },
            responses: {
              201: { description: "Schema saved" },
              400: { description: "Bad request" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              const fields = input.fields;
              if (!Array.isArray(fields)) {
                return {
                  status: 400,
                  body: { error: "fields must be an array of field definitions." },
                };
              }
              return {
                status: 201,
                body: await tenantOf(service, input).schemas.save({
                  collection: params.collection,
                  version: readRequiredNumber(input.version, "Schema version"),
                  activate: input.activate === true,
                  fields: fields as never,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.schemas.activate",
          method: "POST",
          path: "/:collection/activate",
          spec: {
            operationId: "activateSchema",
            summary: "Activate a schema version",
            tags: ["schemas"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["version"],
                properties: {
                  version: { type: "number" },
                },
              },
            },
            responses: {
              200: { description: "Schema activated" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              return {
                body: await tenantOf(service, input).schemas.activate(
                  params.collection,
                  readRequiredNumber(input.version, "Schema version"),
                ),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.schemas.validate",
          method: "POST",
          path: "/:collection/validate",
          spec: {
            operationId: "validateData",
            summary: "Validate data against schema",
            tags: ["schemas"],
            pathParams: {
              collection: { type: "string", required: true, description: "Collection name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: { type: "object", additionalProperties: true },
                },
              },
            },
            responses: {
              200: { description: "Validation successful" },
              400: { description: "Validation failed" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              return {
                body: await tenantOf(service, input).schemas.validate(
                  params.collection,
                  readJsonObject(input.data),
                ),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  };
}

export function defineDatabaseTimeSeriesService(
  database: DatabaseRuntimeApi,
): ZelavisRuntimeService<DatabaseRuntimeApi> {
  return {
    name: "timeseries",
    basePath: "timeseries",
    service: database,
    api: {
      v1: [
        {
          id: "database.timeseries.list",
          method: "GET",
          path: "/series",
          spec: {
            operationId: "listTimeSeries",
            summary: "List time series",
            tags: ["timeseries"],
            queryParams: {
              tenantId: { type: "string", required: true, description: "Tenant ID" },
            },
            responses: {
              200: { description: "List of time series" },
              400: { description: "Bad request" },
            },
          },
          // A series belongs to a Tenant here, where the replaced database kept
          // definitions outside the Tenant boundary. Listing therefore has to
          // say whose series it wants.
          handler: async ({ service, query }) => {
            try {
              return {
                body: {
                  series: await service
                    .forTenant(readTenantId(query.get("tenantId")))
                    .timeSeries.list(),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
        {
          id: "database.timeseries.range",
          method: "POST",
          path: "/:series/range",
          spec: {
            operationId: "queryTimeSeriesRange",
            summary: "Query time series range",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string" },
                  start: { type: "number" },
                  end: { type: "number" },
                  limit: { type: "number" },
                  order: { type: "string" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Time series points" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  points: await service
                    .forTenant(tenantId)
                    .timeSeries.range(params.series, {
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    limit: readNumber(input.limit, 100),
                    order: readTimeSeriesOrder(input.order),
                    tags: readOptionalTagFilter(input.tags),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.aggregate",
          method: "POST",
          path: "/:series/aggregate",
          spec: {
            operationId: "aggregateTimeSeries",
            summary: "Aggregate time series",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "op"],
                properties: {
                  tenantId: { type: "string" },
                  op: { type: "string" },
                  start: { type: "number" },
                  end: { type: "number" },
                  p: { type: "number" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Aggregated value" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  value: await service
                    .forTenant(tenantId)
                    .timeSeries.aggregate(params.series, {
                    op: readTimeSeriesAggregateOperation(input.op),
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    ...(input.p === undefined ? {} : { p: readRequiredNumber(input.p, "p") }),
                    tags: readOptionalTagFilter(input.tags),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.windows",
          method: "POST",
          path: "/:series/windows",
          spec: {
            operationId: "queryTimeSeriesWindows",
            summary: "Query time series windows",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "interval"],
                properties: {
                  tenantId: { type: "string" },
                  interval: { type: "number", description: "Window duration in milliseconds" },
                  step: { type: "number", description: "Step between consecutive window starts in milliseconds" },
                  op: { type: "string", description: "Aggregate operation (default: avg)" },
                  start: { type: "number" },
                  end: { type: "number" },
                  fill: { type: "string", enum: ["none", "zero", "previous", "linear"] },
                  p: { type: "number" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Time series buckets" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  buckets: await service
                    .forTenant(tenantId)
                    .timeSeries.windows(params.series, {
                    interval: readRequiredNumber(input.interval, "interval"),
                    ...(input.step === undefined ? {} : { step: readRequiredNumber(input.step, "step") }),
                    ...(input.op === undefined ? {} : { op: readTimeSeriesAggregateOperation(input.op) }),
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    fill: readOptionalTimeSeriesFill(input.fill),
                    ...(input.p === undefined ? {} : { p: readRequiredNumber(input.p, "p") }),
                    tags: readOptionalTagFilter(input.tags),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.moving",
          method: "POST",
          path: "/:series/moving",
          spec: {
            operationId: "queryTimeSeriesMoving",
            summary: "Query time series moving aggregate",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "window"],
                properties: {
                  tenantId: { type: "string" },
                  window: {
                    type: "object",
                    description: "Rolling window by count or time duration in ms",
                  },
                  op: { type: "string", description: "Aggregate operation (default: avg)" },
                  start: { type: "number" },
                  end: { type: "number" },
                  p: { type: "number" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Moving window points" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  points: await service
                    .forTenant(tenantId)
                    .timeSeries.moving(params.series, {
                    window: readMovingWindow(input.window),
                    ...(input.op === undefined ? {} : { op: readTimeSeriesAggregateOperation(input.op) }),
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    ...(input.p === undefined ? {} : { p: readRequiredNumber(input.p, "p") }),
                    tags: readOptionalTagFilter(input.tags),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.histogram",
          method: "POST",
          path: "/:series/histogram",
          spec: {
            operationId: "queryTimeSeriesHistogram",
            summary: "Query time series histogram",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string" },
                  bins: { type: "number", description: "Number of equal-width bins" },
                  boundaries: { type: "array", items: { type: "number" } },
                  step: { type: "number" },
                  min: { type: "number" },
                  max: { type: "number" },
                  start: { type: "number" },
                  end: { type: "number" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Histogram result" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service
                  .forTenant(tenantId)
                  .timeSeries.histogram(params.series, {
                  ...(input.bins === undefined ? {} : { bins: readRequiredNumber(input.bins, "bins") }),
                  boundaries: readOptionalNumberArray(input.boundaries, "boundaries"),
                  ...(input.step === undefined ? {} : { step: readRequiredNumber(input.step, "step") }),
                  min: readOptionalNumber(input.min, "min"),
                  max: readOptionalNumber(input.max, "max"),
                  start: readOptionalTimeSeriesBoundary(input.start, "start"),
                  end: readOptionalTimeSeriesBoundary(input.end, "end"),
                  tags: readOptionalTagFilter(input.tags),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.interpolate",
          method: "POST",
          path: "/:series/interpolate",
          spec: {
            operationId: "queryTimeSeriesInterpolate",
            summary: "Query time series interpolation",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId", "step"],
                properties: {
                  tenantId: { type: "string" },
                  step: { type: "number", description: "Grid step in milliseconds" },
                  method: { type: "string", enum: ["linear", "previous", "next"] },
                  start: { type: "number" },
                  end: { type: "number" },
                  tags: { type: "object", description: "Filter points by tags" },
                },
              },
            },
            responses: {
              200: { description: "Interpolated points" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: {
                  points: await service
                    .forTenant(tenantId)
                    .timeSeries.interpolate(params.series, {
                    step: readRequiredNumber(input.step, "step"),
                    method: readOptionalInterpolateMethod(input.method),
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    tags: readOptionalTagFilter(input.tags),
                  }),
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
        {
          id: "database.timeseries.ingest",
          method: "POST",
          path: "/:series/ingest",
          spec: {
            operationId: "ingestTimeSeries",
            summary: "Ingest time series from event log",
            tags: ["timeseries"],
            pathParams: {
              series: { type: "string", required: true, description: "Series name" },
            },
            requestBody: {
              required: true,
              schema: {
                type: "object",
                required: ["tenantId"],
                properties: {
                  tenantId: { type: "string" },
                },
              },
            },
            responses: {
              200: { description: "Ingest result" },
              404: { description: "Not found" },
            },
          },
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const tenantId = readTenantId(input.tenantId);
              return {
                body: await service
                  .forTenant(tenantId)
                  .timeSeries.ingest(params.series),
              };
            } catch (error) {
              return databaseErrorResponse(error, 404);
            }
          },
        },
      ],
    },
  };
}
