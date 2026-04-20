import { defineServerService, type ZelavisServerService } from "@zelavis/server";
import type { DatabaseApi } from "../core/types.js";
import type {
  DatabaseDocumentFilter,
  DatabaseDocumentSort,
} from "../contracts/documents.js";
import type { DatabaseJsonObject } from "../contracts/json.js";

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

function errorResponse(status: number, error: unknown) {
  return {
    status,
    body: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

export function createDatabaseServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineServerService({
    name: "database",
    basePath: "database",
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
    services: [createDatabaseDocumentsServerService(database)],
  });
}

export function createDatabaseDocumentsServerService(
  database: DatabaseApi,
): ZelavisServerService<DatabaseApi> {
  return defineServerService({
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
                    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
                      ? (input.metadata as Record<string, unknown>)
                      : undefined,
                }),
              };
            } catch (error) {
              return errorResponse(409, error);
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
              return errorResponse(400, error);
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
              return errorResponse(404, error);
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
              return errorResponse(404, error);
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

export function databaseService(database: DatabaseApi): ZelavisServerService<DatabaseApi> {
  return createDatabaseServerService(database);
}
