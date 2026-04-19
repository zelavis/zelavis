import type { DatabaseDriver } from "../contracts/driver.js";
import { DocumentService } from "../services/document-service.js";
import { createInMemoryDatabaseDriver } from "../storage/in-memory.js";
import type { DatabaseApi } from "./types.js";

export interface CreateDatabaseOptions {
  driver?: DatabaseDriver;
  config?: Record<string, unknown>;
  defaultTenantId?: string;
}

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseApi> {
  const driver = options.driver ?? createInMemoryDatabaseDriver();
  const context = {
    config: options.config ?? {},
    defaultTenantId: options.defaultTenantId ?? "default",
  };

  return {
    context,
    driver,
    capabilities: driver.capabilities,
    documents: new DocumentService(driver.documents, context.defaultTenantId),
    sql: driver.sql,
  };
}
