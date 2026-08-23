import type { DatabaseEventsApi, DatabaseProjectionsApi, DatabaseTimeSeriesApi, DatabaseTimeSeriesDefinition, DatabaseTimeSeriesHandle, DatabaseTimeSeriesSummary } from "../contracts/api.js";
import type { DatabaseTimeSeriesStorageDriver } from "../contracts/driver.js";
export declare class TimeSeriesService implements DatabaseTimeSeriesApi {
    private readonly projections;
    private readonly events;
    private readonly storage;
    private readonly defaultTenantId;
    private readonly definitions;
    constructor(projections: DatabaseProjectionsApi, events: DatabaseEventsApi, storage: DatabaseTimeSeriesStorageDriver | undefined, defaultTenantId: string);
    private ensureProjectionExists;
    private derivePoints;
    private syncStoredSeries;
    define(definition: DatabaseTimeSeriesDefinition): Promise<void>;
    list(): Promise<DatabaseTimeSeriesSummary[]>;
    get(name: string): DatabaseTimeSeriesHandle;
}
