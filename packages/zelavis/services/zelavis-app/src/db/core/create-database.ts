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
  defaultTenantId?: string;
  defaultNodeId?: string;
  schemas?: readonly CollectionSchema[];
}

export async function createDatabase(
  options: CreateDatabaseOptions = {},
): Promise<DatabaseApi> {
  const driver = options.driver ?? createInMemoryDatabaseDriver();
  const context = {
    config: options.config ?? {},
    defaultTenantId: options.defaultTenantId ?? "default",
    defaultNodeId: options.defaultNodeId ?? "local",
  };

  const events = new EventService(
    driver.events,
    context.defaultTenantId,
    context.defaultNodeId,
  );
  const projections = new ProjectionService([
    createBuiltinDocumentProjectionDefinition(),
  ]);
  const timeseries = new TimeSeriesService(
    projections,
    events,
    driver.timeseries,
    context.defaultTenantId,
  );
  const schemas = new SchemaService(driver.schemas);
  await schemas.hydrate();
  for (const schema of options.schemas ?? []) {
    await schemas.save(schema);
  }

  return {
    context,
    driver,
    capabilities: driver.capabilities,
    events,
    projections,
    schemas,
    timeseries,
    documents: new DocumentService(
      events,
      schemas,
      driver.projections,
      context.defaultTenantId,
      context.defaultNodeId,
    ),
    sql: driver.sql,
  };
}
