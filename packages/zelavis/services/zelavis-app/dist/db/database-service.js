import { createMappedJsonErrorResponse, } from "@zelavis/server";
import { DatabaseEventIdempotencyConflictError, } from "./contracts/events.js";
import { DatabaseConflictError, DatabaseDomainError, DatabaseNotFoundError, DatabaseRevisionMismatchError, DatabaseSchemaValidationError, DatabaseValidationError, } from "./core/errors.js";
function readBodyObject(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return {};
    }
    return body;
}
function readString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
const VALID_COLLECTION_SURFACES = new Set([
    "content-studio",
    "database",
]);
function readCollectionSurface(value) {
    return typeof value === "string" && VALID_COLLECTION_SURFACES.has(value)
        ? value
        : undefined;
}
function readJsonObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("A JSON object is required.");
    }
    return value;
}
function readFilters(value) {
    return Array.isArray(value) ? value : [];
}
function readSort(value) {
    return Array.isArray(value) ? value : [];
}
function readNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function readOptionalTimeSeriesBoundary(value, name) {
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
function readTimeSeriesOrder(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (value === "asc" || value === "desc") {
        return value;
    }
    throw new TypeError('order must be either "asc" or "desc".');
}
function readTimeSeriesAggregateOperation(value) {
    if (value === "avg" ||
        value === "sum" ||
        value === "min" ||
        value === "max" ||
        value === "count") {
        return value;
    }
    throw new TypeError('Time-series aggregate op must be one of "avg", "sum", "min", "max", or "count".');
}
function readRequiredNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${name} must be a number.`);
    }
    return value;
}
function readOptionalPositiveInteger(value, fallback) {
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
    zv_collections: "zv_collections",
    zv_events: "zv_events",
    zv_schemas: "zv_schemas",
    zv_time_series_checkpoints: "zv_time_series_checkpoints",
    zv_time_series_points: "zv_time_series_points",
};
function readSystemTableName(value) {
    if (typeof value === "string" && value in systemTableMap) {
        return value;
    }
    throw new TypeError("Unknown system table.");
}
function systemTableOrderBy(table) {
    switch (table) {
        case "zv_collections":
            return "tenant_id ASC, name ASC";
        case "zv_events":
            return "sequence DESC";
        case "zv_schemas":
            return "collection_name ASC, version DESC";
        case "zv_time_series_checkpoints":
            return "updated_at DESC";
        case "zv_time_series_points":
            return "timestamp_ms DESC, point_index DESC";
        default:
            return "1";
    }
}
const databaseErrorRules = [
    {
        matches: (error) => error instanceof TypeError ||
            error instanceof DatabaseValidationError ||
            error instanceof DatabaseSchemaValidationError,
        status: 400,
    },
    {
        matches: (error) => error instanceof DatabaseNotFoundError,
        status: 404,
    },
    {
        matches: (error) => error instanceof DatabaseEventIdempotencyConflictError ||
            error instanceof DatabaseRevisionMismatchError ||
            error instanceof DatabaseConflictError,
        status: 409,
    },
    {
        matches: (error) => error instanceof DatabaseDomainError,
        status: 400,
    },
];
function databaseErrorResponse(error, fallback = 500) {
    return createMappedJsonErrorResponse(error, databaseErrorRules, fallback);
}
export function defineDatabaseService(database) {
    return {
        name: "@zelavis/db",
        basePath: "database",
        menu: {
            title: "Database",
            path: "/database",
            surface: "core",
            panelLabel: "Database",
            dynamicItems: {
                path: "/database/menu/tables",
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
                {
                    title: "System Tables",
                    path: "/database",
                    search: { systemTable: "zv_collections" },
                    panelLabel: "System Tables",
                    items: [
                        {
                            title: "zv_collections",
                            path: "/database",
                            pageLabel: "Database",
                            search: { systemTable: "zv_collections" },
                        },
                        {
                            title: "zv_events",
                            path: "/database",
                            pageLabel: "Database",
                            search: { systemTable: "zv_events" },
                        },
                        {
                            title: "zv_schemas",
                            path: "/database",
                            pageLabel: "Database",
                            search: { systemTable: "zv_schemas" },
                        },
                        {
                            title: "zv_time_series_checkpoints",
                            path: "/database",
                            pageLabel: "Database",
                            search: { systemTable: "zv_time_series_checkpoints" },
                        },
                        {
                            title: "zv_time_series_points",
                            path: "/database",
                            pageLabel: "Database",
                            search: { systemTable: "zv_time_series_points" },
                        },
                    ],
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
                        const tenantId = query.get("tenantId") ?? undefined;
                        const collections = await service.documents.listCollections({
                            tenantId,
                        });
                        return {
                            body: {
                                items: collections
                                    .filter((collection) => !(collection.name in systemTableMap))
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
                            driver: service.driver.name,
                            capabilities: service.capabilities,
                            defaultTenantId: service.context.defaultTenantId,
                        },
                    }),
                },
            ],
        },
        services: [
            defineDatabaseDocumentsService(database),
            defineDatabaseSchemasService(database),
            defineDatabaseTimeSeriesService(database),
            defineDatabaseSqlService(database),
        ],
    };
}
export function defineDatabaseSqlService(database) {
    return {
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
                            const limit = Math.min(readOptionalPositiveInteger(query.get("limit"), 100), 500);
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
                        }
                        catch (error) {
                            return databaseErrorResponse(error, 400);
                        }
                    },
                },
            ],
        },
    };
}
export function defineDatabaseDocumentsService(database) {
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
                                    surface: readCollectionSurface(input.surface),
                                    metadata: input.metadata &&
                                        typeof input.metadata === "object" &&
                                        !Array.isArray(input.metadata)
                                        ? input.metadata
                                        : undefined,
                                }),
                            };
                        }
                        catch (error) {
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
                        }
                        catch (error) {
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
                        }
                        catch (error) {
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
                        }
                        catch (error) {
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
    };
}
export function defineDatabaseSchemasService(database) {
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
                                    fields: fields,
                                }),
                            };
                        }
                        catch (error) {
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
                                body: await service.schemas.activate(params.collection, readRequiredNumber(input.version, "Schema version")),
                            };
                        }
                        catch (error) {
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
                                body: service.schemas.validate(params.collection, readJsonObject(input.data)),
                            };
                        }
                        catch (error) {
                            return databaseErrorResponse(error, 400);
                        }
                    },
                },
            ],
        },
    };
}
export function defineDatabaseTimeSeriesService(database) {
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
                        }
                        catch (error) {
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
                        }
                        catch (error) {
                            return databaseErrorResponse(error, 404);
                        }
                    },
                },
            ],
        },
    };
}
