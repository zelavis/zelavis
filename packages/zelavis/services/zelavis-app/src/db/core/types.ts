import type {
  DatabaseDriver,
  DatabaseCapabilities,
} from "../contracts/driver.js";
import type {
  DatabaseContext,
  DatabaseDocumentsApi,
  DatabaseEventsApi,
  DatabaseProjectionsApi,
  DatabaseSchemasApi,
  DatabaseTimeSeriesApi,
} from "../contracts/api.js";
import type { SqlDatabase } from "../contracts/sql.js";

export type {
  DatabaseContext,
  DatabaseDocumentsApi,
  DatabaseEventsApi,
  DatabaseProjectionsApi,
  DatabaseSchemasApi,
  DatabaseTimeSeriesApi,
} from "../contracts/api.js";

export interface DatabaseApi {
  context: DatabaseContext;
  driver: DatabaseDriver;
  capabilities: DatabaseCapabilities;
  events: DatabaseEventsApi;
  projections: DatabaseProjectionsApi;
  schemas: DatabaseSchemasApi;
  timeseries: DatabaseTimeSeriesApi;
  documents: DatabaseDocumentsApi;
  sql?: SqlDatabase;
}
