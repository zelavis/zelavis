import type { DatabaseEventDriver } from "../contracts/driver.js";
import type { DatabaseEventsApi } from "../contracts/api.js";
import type {
  DatabaseAppendEventInput,
  DatabaseEvent,
  DatabaseEventPayload,
  ReadDatabaseEventsInput,
} from "../contracts/events.js";
import { validateDatabaseCollectionName } from "../contracts/documents.js";

export class EventService implements DatabaseEventsApi {
  constructor(
    private readonly driver: DatabaseEventDriver,
    private readonly tenantId: string,
    private readonly defaultNodeId: string,
  ) {}

  append<TPayload extends DatabaseEventPayload>(
    input: DatabaseAppendEventInput<TPayload>,
  ): Promise<DatabaseEvent<TPayload>> {
    validateDatabaseCollectionName(input.collection);

    return this.driver.append({
      ...input,
      tenantId: this.tenantId,
      nodeId: input.nodeId ?? this.defaultNodeId,
    });
  }

  read(input: ReadDatabaseEventsInput = {}): Promise<DatabaseEvent[]> {
    return this.driver.read({ ...input, tenantId: this.tenantId });
  }
}
