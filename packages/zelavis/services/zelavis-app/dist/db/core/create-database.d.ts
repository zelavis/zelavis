import type { DatabaseDriver } from "../contracts/driver.js";
import type { CollectionSchema } from "../schema/index.js";
import type { DatabaseApi } from "./types.js";
export interface CreateDatabaseOptions {
    driver?: DatabaseDriver;
    config?: Record<string, unknown>;
    defaultTenantId?: string;
    defaultNodeId?: string;
    schemas?: readonly CollectionSchema[];
}
export declare function createDatabase(options?: CreateDatabaseOptions): Promise<DatabaseApi>;
