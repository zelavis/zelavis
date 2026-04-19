import type { DatabaseAdapter } from "../contracts/adapter.js";
import { DocumentService } from "../services/document-service.js";
import { createInMemoryDatabaseAdapter } from "../storage/in-memory.js";
import type { DatabaseApi } from "./types.js";

export interface CreateDatabaseOptions {
  adapter?: DatabaseAdapter;
  config?: Record<string, unknown>;
  defaultTenantId?: string;
}

export async function createDatabase(options: CreateDatabaseOptions = {}): Promise<DatabaseApi> {
  const adapter = options.adapter ?? createInMemoryDatabaseAdapter();
  const context = {
    config: options.config ?? {},
    defaultTenantId: options.defaultTenantId ?? "default",
  };

  return {
    context,
    adapter,
    capabilities: adapter.capabilities,
    documents: new DocumentService(adapter.documents, context.defaultTenantId),
    sql: adapter.sql,
  };
}
