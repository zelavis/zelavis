import {
  createMappedJsonErrorResponse,
  type ZelavisServerErrorStatusRule,
  type ZelavisRuntimeService,
} from "../../core/index.js";
import type { DatabaseApi } from "./core/types.js";
import type {
  DatabaseCollectionSurface,
  DatabaseDocumentFilter,
  DatabaseDocumentSort,
} from "./contracts/documents.js";
import type { DatabaseJsonObject } from "./contracts/json.js";
import type {
  DatabaseTimeSeriesAggregateOperation,
  DatabaseTimeSeriesRangeInput,
} from "./contracts/api.js";
import type { DatabaseEventCursor } from "./contracts/events.js";
import type {
  DatabaseSystemViewName,
  DatabaseTenantBackupV1,
} from "./contracts/maintenance.js";
import {
  DatabaseEventIdempotencyConflictError,
} from "./contracts/events.js";
import {
  DatabaseConflictError,
  DatabaseDomainError,
  DatabaseNotFoundError,
  DatabaseRevisionMismatchError,
  DatabaseSchemaValidationError,
  DatabaseValidationError,
} from "./core/errors.js";

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
function tenantOf(service: DatabaseApi, input: Record<string, unknown>) {
  return service.forTenant(readTenantId(input.tenantId));
}

function readTenantId(value: unknown): string {
  const tenantId = readString(value);
  if (!tenantId) throw new TypeError("A Tenant ID is required.");
  return tenantId;
}

const VALID_COLLECTION_SURFACES = new Set<DatabaseCollectionSurface>([
  "content-studio",
  "database",
]);

function readCollectionSurface(value: unknown): DatabaseCollectionSurface | undefined {
  return typeof value === "string" && VALID_COLLECTION_SURFACES.has(value as DatabaseCollectionSurface)
    ? (value as DatabaseCollectionSurface)
    : undefined;
}

function readJsonObject(value: unknown): DatabaseJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A JSON object is required.");
  }

  return value as DatabaseJsonObject;
}

function readFilters(value: unknown): DatabaseDocumentFilter[] {
  return Array.isArray(value) ? (value as DatabaseDocumentFilter[]) : [];
}

function readSort(value: unknown): DatabaseDocumentSort[] {
  return Array.isArray(value) ? (value as DatabaseDocumentSort[]) : [];
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

function readTimeSeriesOrder(
  value: unknown,
): DatabaseTimeSeriesRangeInput["order"] {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "asc" || value === "desc") {
    return value;
  }

  throw new TypeError('order must be either "asc" or "desc".');
}

function readTimeSeriesAggregateOperation(
  value: unknown,
): DatabaseTimeSeriesAggregateOperation {
  if (
    value === "avg" ||
    value === "sum" ||
    value === "min" ||
    value === "max" ||
    value === "count"
  ) {
    return value;
  }

  throw new TypeError(
    'Time-series aggregate op must be one of "avg", "sum", "min", "max", or "count".',
  );
}

function readRequiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a number.`);
  }

  return value;
}

const databaseErrorRules: readonly ZelavisServerErrorStatusRule[] = [
  {
    matches: (error) =>
      error instanceof TypeError ||
      error instanceof DatabaseValidationError ||
      error instanceof DatabaseSchemaValidationError,
    status: 400,
  },
  {
    matches: (error) => error instanceof DatabaseNotFoundError,
    status: 404,
  },
  {
    matches: (error) =>
      error instanceof DatabaseEventIdempotencyConflictError ||
      error instanceof DatabaseRevisionMismatchError ||
      error instanceof DatabaseConflictError,
    status: 409,
  },
  {
    matches: (error) => error instanceof DatabaseDomainError,
    status: 400,
  },
];

function databaseErrorResponse(error: unknown, fallback = 500) {
  return createMappedJsonErrorResponse(error, databaseErrorRules, fallback);
}

export type DatabaseServiceDefinition = ZelavisRuntimeService<DatabaseApi>;

export function defineDatabaseService(
  database: DatabaseApi,
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
                  ...collections
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
          handler: ({ service }) => ({
            body: {
              status: "ok",
              nodeId: service.context.nodeId,
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
  database: DatabaseApi,
): ZelavisRuntimeService<DatabaseApi> {
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
                  name: params.view as DatabaseSystemViewName,
                  tenantId: readTenantId(query.get("tenantId")),
                  limit: readQueryNumber(query.get("limit")),
                  after: query.get("after") as DatabaseEventCursor | null ?? undefined,
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
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
                body: await service.backups.exportTenant(readTenantId(input.tenantId)),
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
              return {
                body: await service.backups.restoreTenant(
                  input.backup as unknown as DatabaseTenantBackupV1,
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

export function defineDatabaseDocumentsService(
  database: DatabaseApi,
): ZelavisRuntimeService<DatabaseApi> {
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
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 409);
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
                    where: readFilters(input.where),
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
            },
            responses: {
              200: { description: "Document deleted" },
              400: { description: "Bad request" },
            },
          },
          handler: async ({ service, params, query }) => {
            try {
              const tenantId = readTenantId(query.get("tenantId"));
              return {
                body: {
                  deleted: await service.forTenant(tenantId).documents.delete({
                    collection: params.collection,
                    id: params.id,
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
  database: DatabaseApi,
): ZelavisRuntimeService<DatabaseApi> {
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
          handler: ({ service, query }) => ({
            body: {
              collections: service
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
          handler: ({ service, params, query }) => ({
            body: {
              collection: params.collection,
              schemas: service
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
          handler: ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              return {
                body: tenantOf(service, input).schemas.validate(
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
  database: DatabaseApi,
): ZelavisRuntimeService<DatabaseApi> {
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
            responses: {
              200: { description: "List of time series" },
            },
          },
          handler: async ({ service }) => ({
            body: {
              series: await service.timeseries.list(),
            },
          }),
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
                    .timeseries.get(params.series).range({
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                    limit: readNumber(input.limit, 100),
                    order: readTimeSeriesOrder(input.order),
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
                    .timeseries.get(params.series).aggregate({
                    op: readTimeSeriesAggregateOperation(input.op),
                    start: readOptionalTimeSeriesBoundary(input.start, "start"),
                    end: readOptionalTimeSeriesBoundary(input.end, "end"),
                  }),
                },
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
