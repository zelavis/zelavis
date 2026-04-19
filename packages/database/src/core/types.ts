import type { DatabaseDriver, DatabaseCapabilities } from "../contracts/driver.js";
import type { SqlDatabase } from "../contracts/sql.js";
import type { DocumentService } from "../services/document-service.js";

export interface DatabaseContext {
  config: Record<string, unknown>;
  defaultTenantId: string;
}

export interface DatabaseApi {
  context: DatabaseContext;
  driver: DatabaseDriver;
  capabilities: DatabaseCapabilities;
  documents: DocumentService;
  sql?: SqlDatabase;
}
