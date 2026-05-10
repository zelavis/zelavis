import {
  createMappedJsonErrorResponse,
  defineService,
  type ZelavisServerErrorStatusRule,
  type ZelavisServerService,
} from "@zelavis/server";
import type { DatabaseApi } from "./core/types.js";
import type {
  DatabaseDocumentFilter,
  DatabaseDocumentSort,
} from "./contracts/documents.js";
import type { DatabaseJsonObject } from "./contracts/json.js";
import type {
  DatabaseCollectionSchema,
  DatabaseObjectSchemaDefinition,
} from "./contracts/schemas.js";
import type {
  DatabaseTimeSeriesAggregateOperation,
  DatabaseTimeSeriesRangeInput,
} from "./contracts/api.js";
import {
  DatabaseEventIdempotencyConflictError,
} from "./contracts/events.js";
import { DatabaseSchemaValidationError } from "./contracts/schemas.js";
import {
  DatabaseConflictError,
  DatabaseDomainError,
  DatabaseNotFoundError,
  DatabaseRevisionMismatchError,
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

function readOptionalPositiveInteger(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError("Expected a positive integer.");
  }

  return number;
}

const systemTableMap = {
  _collections: "collections",
  _documents: "documents",
  _events: "events",
  _schemas: "schemas",
  _time_series_checkpoints: "time_series_checkpoints",
  _time_series_points: "time_series_points",
} as const;

type DatabaseSystemTableName = keyof typeof systemTableMap;

function readSystemTableName(value: unknown): DatabaseSystemTableName {
  if (typeof value === "string" && value in systemTableMap) {
    return value as DatabaseSystemTableName;
  }

  throw new TypeError("Unknown system table.");
}

function systemTableOrderBy(table: DatabaseSystemTableName) {
  switch (table) {
    case "_collections":
      return "tenant_id ASC, name ASC";
    case "_documents":
      return "updated_at DESC, id ASC";
    case "_events":
      return "sequence DESC";
    case "_schemas":
      return "collection_name ASC, version DESC";
    case "_time_series_checkpoints":
      return "updated_at DESC";
    case "_time_series_points":
      return "timestamp_ms DESC, point_index DESC";
    default:
      return "1";
  }
}

function readSchemaDefinition(value: unknown): DatabaseObjectSchemaDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A schema document definition is required.");
  }

  if ((value as { type?: unknown }).type !== "object") {
    throw new TypeError(
      "Schema document definitions must use an object root type.",
    );
  }

  return value as DatabaseObjectSchemaDefinition;
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

export function createDatabaseServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineService({
    name: "database",
    basePath: "database",
    menu: {
      title: "Database",
      surface: "core",
      panelLabel: "Tables",
      items: [
        {
          title: "System Tables",
          panelLabel: "System Tables",
          items: [
            {
              title: "_collections",
              path: "/database",
            },
            {
              title: "_documents",
              path: "/database",
            },
            {
              title: "_events",
              path: "/database",
            },
            {
              title: "_schemas",
              path: "/database",
            },
            {
              title: "_time_series_checkpoints",
              path: "/database",
            },
            {
              title: "_time_series_points",
              path: "/database",
            },
          ],
        },
      ],
    },
    service: database,
    api: {
      v1: [
        {
          id: "database.health",
          method: "GET",
          path: "/health",
          handler: ({ service }) => ({
            body: {
              status: "ok",
              driver: service.driver.name,
              capabilities: service.capabilities,
              defaultTenantId: service.context.defaultTenantId,
            },
          }),
        },
      ],
    },
    services: [
      createDatabaseDocumentsServerService(database),
      createDatabaseSchemasServerService(database),
      createDatabaseTimeSeriesServerService(database),
      createDatabaseSqlServerService(database),
    ],
  });
}

export function createDatabaseSqlServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineService({
    name: "sql",
    basePath: "sql",
    service: database,
    api: {
      v1: [
        {
          id: "database.sql.systemTables.list",
          method: "GET",
          path: "/system/tables",
          handler: ({ service }) => {
            if (!service.sql) {
              return {
                status: 501,
                body: {
                  error: "SQL capability is not available for this database driver.",
                },
              };
            }

            return {
              body: {
                tables: Object.entries(systemTableMap).map(([name, physicalName]) => ({
                  name,
                  physicalName,
                })),
              },
            };
          },
        },
        {
          id: "database.sql.systemTables.query",
          method: "GET",
          path: "/system/:table",
          handler: async ({ service, params, query }) => {
            if (!service.sql) {
              return {
                status: 501,
                body: {
                  error: "SQL capability is not available for this database driver.",
                },
              };
            }

            try {
              const table = readSystemTableName(params.table);
              const limit = Math.min(
                readOptionalPositiveInteger(query.get("limit"), 100),
                500,
              );
              const rows = await service.sql.query({
                statement: `SELECT * FROM ${systemTableMap[table]} ORDER BY ${systemTableOrderBy(table)} LIMIT ?`,
                parameters: [limit],
              });

              return {
                body: {
                  table,
                  rows: rows.rows,
                },
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  });
}

export function createDatabaseDocumentsServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineService({
    name: "documents",
    basePath: "documents",
    service: database,
    api: {
      v1: [
        {
          id: "database.collections.list",
          method: "GET",
          path: "/collections",
          handler: async ({ service, query }) => ({
            body: {
              collections: await service.documents.listCollections({
                tenantId: query.get("tenantId") ?? undefined,
              }),
            },
          }),
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
              return {
                status: 201,
                body: await service.documents.createCollection({
                  name,
                  tenantId: readString(input.tenantId),
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
              return {
                status: 201,
                body: await service.documents.insert({
                  collection: params.collection,
                  tenantId: readString(input.tenantId),
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
            const document = await service.documents.findById({
              collection: params.collection,
              id: params.id,
              tenantId: query.get("tenantId") ?? undefined,
            });

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
              return {
                body: {
                  documents: await service.documents.findMany({
                    collection: params.collection,
                    tenantId: readString(input.tenantId),
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
              return {
                body: await service.documents.update({
                  collection: params.collection,
                  id: params.id,
                  tenantId: readString(input.tenantId),
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
          handler: async ({ service, params, query }) => ({
            body: {
              deleted: await service.documents.delete({
                collection: params.collection,
                id: params.id,
                tenantId: query.get("tenantId") ?? undefined,
              }),
            },
          }),
        },
      ],
    },
  });
}

export function createDatabaseSchemasServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineService({
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
              schemas: service.schemas.listVersionRecords(params.collection),
            },
          }),
        },
        {
          id: "database.schemas.register",
          method: "POST",
          path: "/:collection",
          handler: async ({ service, params, body }) => {
            const input = readBodyObject(body);

            try {
              const schema: DatabaseCollectionSchema = {
                collection: params.collection,
                version: readRequiredNumber(input.version, "Schema version"),
                activate: input.activate === true,
                document: readSchemaDefinition(input.document),
                metadata:
                  input.metadata &&
                  typeof input.metadata === "object" &&
                  !Array.isArray(input.metadata)
                    ? (input.metadata as Record<string, unknown>)
                    : undefined,
              };

              return {
                status: 201,
                body: await service.schemas.register(schema),
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
                body: service.schemas.validate({
                  collection: params.collection,
                  version:
                    typeof input.version === "number"
                      ? input.version
                      : undefined,
                  data: readJsonObject(input.data),
                }),
              };
            } catch (error) {
              return databaseErrorResponse(error, 400);
            }
          },
        },
      ],
    },
  });
}

export function createDatabaseTimeSeriesServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineService({
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
              return {
                body: {
                  points: await service.timeseries.get(params.series).range({
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
              return {
                body: {
                  value: await service.timeseries.get(params.series).aggregate({
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
  });
}

export function databaseService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return createDatabaseServerService(database);
}
