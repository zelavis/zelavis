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
  /**
   * Reached through the Tenant so callers already address them that way.
   *
   * This driver still stores both for the whole logical database, so the Tenant
   * selects nothing yet. `zelavis/dbnew` owns them per Tenant, and moving the
   * routes first means the change of backing store is not also a change of URL.
   */
  schemas: DatabaseSchemasApi;
  systemViews: DatabaseSystemViewsApi;
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
