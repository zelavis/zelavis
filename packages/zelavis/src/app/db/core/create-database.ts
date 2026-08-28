import type { DatabaseDriver } from "../contracts/driver.js";
import type { CollectionSchema } from "../schema/index.js";
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
  const database: DatabaseApi = {
    context,
    capabilities: driver.capabilities,
    projections,
    schemas,
    timeseries,
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
      });
      tenantApis.set(tenantId, tenant);
      return tenant;
    },
  };

  return database;
}
