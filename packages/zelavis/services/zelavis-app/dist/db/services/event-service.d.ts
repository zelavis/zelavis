import type { DatabaseEventDriver } from "../contracts/driver.js";
import type { DatabaseEventsApi } from "../contracts/api.js";
import type { DatabaseAppendEventInput, DatabaseEvent, DatabaseEventPayload, ReadDatabaseEventsInput } from "../contracts/events.js";
export declare class EventService implements DatabaseEventsApi {
    private readonly driver;
    private readonly defaultTenantId;
    private readonly defaultNodeId;
    constructor(driver: DatabaseEventDriver, defaultTenantId: string, defaultNodeId: string);
    append<TPayload extends DatabaseEventPayload>(input: DatabaseAppendEventInput<TPayload>): Promise<DatabaseEvent<TPayload>>;
    read(input?: ReadDatabaseEventsInput): Promise<DatabaseEvent[]>;
}
