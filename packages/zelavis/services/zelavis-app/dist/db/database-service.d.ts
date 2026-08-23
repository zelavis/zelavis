import { type ZelavisRuntimeService } from "../server/index.js";
import type { DatabaseApi } from "./core/types.js";
export type DatabaseServiceDefinition = ZelavisRuntimeService<DatabaseApi>;
export declare function defineDatabaseService(database: DatabaseApi): DatabaseServiceDefinition;
export declare function defineDatabaseSqlService(database: DatabaseApi): ZelavisRuntimeService<DatabaseApi>;
export declare function defineDatabaseDocumentsService(database: DatabaseApi): ZelavisRuntimeService<DatabaseApi>;
export declare function defineDatabaseSchemasService(database: DatabaseApi): ZelavisRuntimeService<DatabaseApi>;
export declare function defineDatabaseTimeSeriesService(database: DatabaseApi): ZelavisRuntimeService<DatabaseApi>;
