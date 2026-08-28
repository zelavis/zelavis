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
          method: "GET",
          path: "/menu/tables",
          handler: async ({ service, query }) => {
            const tenantId = readTenantId(query.get("tenantId"));
            const collections = await service
              .forTenant(tenantId)
              .documents.listCollections();

            return {
              body: {
                items: collections
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((collection) => ({
                    title: collection.name,
                    path: "/database",
                    pageLabel: "Database",
                    search: { databaseTable: collection.name },
                  })),
              },
            };
          },
        },
        {
          id: "database.health",
          method: "GET",
          path: "/health",
          handler: ({ service }) => ({
            body: {
              status: "ok",
              capabilities: service.capabilities,
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
    ],
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
          handler: ({ service }) => ({
            body: {
              collections: service.schemas.listCollections(),
            },
          }),
        },
        {
          id: "database.schemas.versions.list",
          method: "GET",
          path: "/:collection",
          handler: ({ service, params }) => ({
            body: {
              collection: params.collection,
              schemas: service.schemas.listVersions(params.collection),
            },
          }),
        },
        {
          id: "database.schemas.save",
          method: "POST",
          path: "/:collection",
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
                body: await service.schemas.save({
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
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              return {
                body: await service.schemas.activate(
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
          handler: ({ service, params, body }) => {
            const input = readBodyObject(body);
            try {
              return {
                body: service.schemas.validate(
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
