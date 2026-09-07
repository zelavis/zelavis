import type { DatabaseJsonObject } from "./json.js";
import type { DatabaseEvent, DatabaseEventCursor } from "./events.js";
import type { DatabaseTenantId } from "./documents.js";
import type { StoredCollectionSchema } from "../../../dbnew/schema/index.js";

export const ZELAVIS_DATABASE_BACKUP_V1 = "zelavis.database-backup.v1" as const;

export type DatabaseSystemViewName =
  | "collections"
  | "events"
  | "schemas"
  | "projections"
  | "time-series";

export interface DatabaseSystemView {
  readonly name: DatabaseSystemViewName;
  readonly title: string;
  readonly tenantScoped: boolean;
}

export interface DatabaseSystemViewRow {
  readonly id: string;
  readonly data: DatabaseJsonObject;
}

export interface QueryDatabaseSystemViewInput {
  readonly name: DatabaseSystemViewName;
  readonly tenantId: DatabaseTenantId;
  readonly limit?: number;
  readonly after?: DatabaseEventCursor;
}

export interface DatabaseSystemViewResult {
  readonly rows: readonly DatabaseSystemViewRow[];
  readonly next?: DatabaseEventCursor;
}

export interface DatabaseSystemViewsApi {
  list(): readonly DatabaseSystemView[];
  query(input: QueryDatabaseSystemViewInput): Promise<DatabaseSystemViewResult>;
}

export interface DatabaseTenantBackupV1 {
  readonly format: typeof ZELAVIS_DATABASE_BACKUP_V1;
  readonly exportedAt: string;
  readonly tenantId: DatabaseTenantId;
  readonly schemas: readonly StoredCollectionSchema[];
  readonly events: readonly DatabaseEvent[];
}

export interface RestoreDatabaseTenantBackupResult {
  readonly tenantId: DatabaseTenantId;
  readonly schemas: number;
  readonly events: number;
}

export interface DatabaseBackupsApi {
  exportTenant(tenantId: DatabaseTenantId): Promise<DatabaseTenantBackupV1>;
  restoreTenant(
    backup: DatabaseTenantBackupV1,
  ): Promise<RestoreDatabaseTenantBackupResult>;
}
