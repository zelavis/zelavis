import type { DatabaseCapabilities } from "../contracts/driver.js";
import type {
  DatabaseContext,
  DatabaseDocumentsApi,
  DatabaseEventsApi,
  DatabaseProjectionsApi,
  DatabaseSchemasApi,
  DatabaseTenantTimeSeriesApi,
  DatabaseTimeSeriesDefinitionsApi,
} from "../contracts/api.js";
import type { DatabaseTenantId } from "../contracts/documents.js";
import type {
  DatabaseBackupsApi,
  DatabaseSystemViewsApi,
} from "../contracts/maintenance.js";

export type {
  DatabaseContext,
  DatabaseDocumentsApi,
  DatabaseEventsApi,
  DatabaseProjectionsApi,
  DatabaseSchemasApi,
  DatabaseTenantTimeSeriesApi,
  DatabaseTimeSeriesDefinitionsApi,
} from "../contracts/api.js";

export interface TenantDatabaseApi {
  tenantId: DatabaseTenantId;
  events: DatabaseEventsApi;
  timeseries: DatabaseTenantTimeSeriesApi;
  documents: DatabaseDocumentsApi;
}

export interface DatabaseApi {
  context: DatabaseContext;
  capabilities: DatabaseCapabilities;
  projections: DatabaseProjectionsApi;
  schemas: DatabaseSchemasApi;
  timeseries: DatabaseTimeSeriesDefinitionsApi;
  systemViews: DatabaseSystemViewsApi;
  backups: DatabaseBackupsApi;
  forTenant(tenantId: DatabaseTenantId): TenantDatabaseApi;
}
