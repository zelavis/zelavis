import type { DatabaseDriver } from "../contracts/driver.js";
import type { CollectionSchema } from "../../../dbnew/schema/index.js";
import { DocumentService } from "../services/document-service.js";
import { EventService } from "../services/event-service.js";
import {
  createBuiltinDocumentProjectionDefinition,
  ProjectionService,
} from "../services/projection-service.js";
import { SchemaService } from "../services/schema-service.js";
import { TimeSeriesService } from "../services/time-series-service.js";
import { createInMemoryDatabaseDriver } from "../storage/in-memory.js";
import type { DatabaseApi } from "./types.js";
import {
  ZELAVIS_DATABASE_BACKUP_V1,
  type DatabaseSystemView,
  type DatabaseSystemViewName,
  type DatabaseSystemViewRow,
} from "../contracts/maintenance.js";
import type { DatabaseJsonObject } from "../contracts/json.js";

const SYSTEM_VIEWS: readonly DatabaseSystemView[] = Object.freeze([
  { name: "collections", title: "Collections", tenantScoped: true },
  { name: "events", title: "Events", tenantScoped: true },
  { name: "schemas", title: "Schemas", tenantScoped: false },
  { name: "projections", title: "Projections", tenantScoped: false },
  { name: "time-series", title: "Time series", tenantScoped: false },
]);

function systemRow(id: string, data: DatabaseJsonObject): DatabaseSystemViewRow {
  return { id, data };
}

function assertSystemViewName(name: string): asserts name is DatabaseSystemViewName {
  if (!SYSTEM_VIEWS.some((view) => view.name === name)) {
    throw new TypeError(`Unknown logical database system view "${name}".`);
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("A system-view limit must be an integer from 1 through 500.");
  }
  return limit;
}

export interface CreateDatabaseOptions {
  driver?: DatabaseDriver;
  config?: Record<string, unknown>;
  nodeId?: string;
  schemas?: readonly CollectionSchema[];
}

export async function createDatabase(
  options: CreateDatabaseOptions = {},
): Promise<DatabaseApi> {
  const driver = options.driver ?? createInMemoryDatabaseDriver();
  const context = {
    config: options.config ?? {},
    nodeId: options.nodeId ?? "local",
  };
  const projections = new ProjectionService([
    createBuiltinDocumentProjectionDefinition(),
  ]);
  const timeseries = new TimeSeriesService(
    projections,
    driver.timeseries,
  );
  const schemas = new SchemaService(driver.schemas);
  await schemas.hydrate();
  for (const schema of options.schemas ?? []) {
    await schemas.save(schema);
  }

  const tenantApis = new Map<string, ReturnType<DatabaseApi["forTenant"]>>();
  let database!: DatabaseApi;
  database = {
    context,
    capabilities: driver.capabilities,
    projections,
    schemas,
    timeseries,
    systemViews: {
      list: () => SYSTEM_VIEWS,
      async query(input) {
        assertSystemViewName(input.name);
        const limit = boundedLimit(input.limit);
        const tenant = database.forTenant(input.tenantId);

        if (input.name === "collections") {
          const collections = await tenant.documents.listCollections();
          return {
            rows: collections.slice(0, limit).map((collection) =>
              systemRow(collection.name, {
                name: collection.name,
                tenantId: collection.tenantId,
                createdAt: collection.createdAt.toISOString(),
                documentCount: collection.documentCount,
                ...(collection.surface ? { surface: collection.surface } : {}),
                ...(collection.metadata ? { metadata: collection.metadata as DatabaseJsonObject } : {}),
              }),
            ),
          };
        }

        if (input.name === "events") {
          const events = await tenant.events.read({ after: input.after, limit });
          return {
            rows: events.map((event) =>
              systemRow(event.eventId, {
                cursor: event.cursor,
                eventId: event.eventId,
                nodeId: event.nodeId,
                tenantId: event.tenantId,
                collection: event.collection,
                ...(event.documentId ? { documentId: event.documentId } : {}),
                type: event.type,
                revision: event.revision,
                timestamp: event.timestamp,
                schemaVersion: event.schemaVersion,
                payload: event.payload as DatabaseJsonObject,
              }),
            ),
            ...(events.length === limit
              ? { next: events[events.length - 1]?.cursor }
              : {}),
          };
        }

        if (input.name === "schemas") {
          const schemas = database.schemas.listCollections().flatMap((summary) =>
            database.schemas.listVersions(summary.collection),
          );
          return {
            rows: schemas.slice(0, limit).map((schema) =>
              systemRow(`${schema.collection}@${schema.version}`, {
                collection: schema.collection,
                version: schema.version,
                active: schema.active,
                fields: schema.fields as unknown as DatabaseJsonObject["fields"],
              }),
            ),
          };
        }

        if (input.name === "projections") {
          const definitions = await database.projections.list();
          return {
            rows: definitions.slice(0, limit).map((projection) =>
              systemRow(projection.name, {
                name: projection.name,
                builtin: projection.builtin,
                ...(projection.description ? { description: projection.description } : {}),
                ...(projection.sourceCollections
                  ? { sourceCollections: [...projection.sourceCollections] }
                  : {}),
                ...(projection.sourceEventTypes
                  ? { sourceEventTypes: [...projection.sourceEventTypes] }
                  : {}),
              }),
            ),
          };
        }

        const definitions = await database.timeseries.list();
        return {
          rows: definitions.slice(0, limit).map((series) =>
            systemRow(series.name, {
              name: series.name,
              ...(series.description ? { description: series.description } : {}),
              ...(series.version !== undefined ? { version: series.version } : {}),
              ...(series.projection ? { projection: series.projection } : {}),
            }),
          ),
        };
      },
    },
    backups: {
      async exportTenant(tenantId) {
        const tenant = database.forTenant(tenantId);
        const events = [];
        let after;
        do {
          const page = await tenant.events.read({ after, limit: 500 });
          events.push(...page);
          after = page.length === 500 ? page[page.length - 1]?.cursor : undefined;
        } while (after);

        return {
          format: ZELAVIS_DATABASE_BACKUP_V1,
          exportedAt: new Date().toISOString(),
          tenantId,
          schemas: database.schemas.listCollections().flatMap((summary) =>
            database.schemas.listVersions(summary.collection),
          ),
          events,
        };
      },
      async restoreTenant(backup) {
        if (backup.format !== ZELAVIS_DATABASE_BACKUP_V1) {
          throw new TypeError("Unsupported database backup format.");
        }
        database.forTenant(backup.tenantId);
        if (!driver.events.restore) {
          throw new TypeError(
            `Database driver "${driver.name}" does not support exact event restoration.`,
          );
        }

        for (const schema of backup.schemas) {
          await database.schemas.save({
            collection: schema.collection,
            version: schema.version,
            fields: schema.fields,
            activate: false,
          });
        }
        for (const schema of backup.schemas.filter((item) => item.active)) {
          await database.schemas.activate(schema.collection, schema.version);
        }
        for (const event of backup.events) {
          await driver.events.restore({
            tenantId: backup.tenantId,
            eventId: event.eventId,
            nodeId: event.nodeId,
            idempotencyKey: event.idempotencyKey,
            collection: event.collection,
            documentId: event.documentId,
            type: event.type,
            revision: event.revision,
            timestamp: event.timestamp,
            schemaVersion: event.schemaVersion,
            payload: event.payload,
          });
        }

        return {
          tenantId: backup.tenantId,
          schemas: backup.schemas.length,
          events: backup.events.length,
        };
      },
    },
    forTenant(tenantId) {
      if (tenantId.length === 0 || tenantId.trim() !== tenantId) {
        throw new TypeError(
          "A Tenant ID must be non-empty and contain no surrounding whitespace.",
        );
      }

      const existing = tenantApis.get(tenantId);
      if (existing) return existing;

      const events = new EventService(driver.events, tenantId, context.nodeId);
      const tenant = Object.freeze({
        tenantId,
        events,
        timeseries: timeseries.forTenant(tenantId, events),
        documents: new DocumentService(
          events,
          schemas,
          driver.projections,
          tenantId,
          context.nodeId,
        ),
        schemas: database.schemas,
        systemViews: database.systemViews,
      });
      tenantApis.set(tenantId, tenant);
      return tenant;
    },
  };

  return database;
}
