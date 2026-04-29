import type { DatabaseEventDriver } from "../contracts/driver.js";
import type { DatabaseEventsApi } from "../contracts/api.js";
import type {
  DatabaseAppendEventInput,
  DatabaseEvent,
  DatabaseEventPayload,
  ReadDatabaseEventsInput,
} from "../contracts/events.js";

function withTenantId<TInput extends { tenantId?: string }>(
  input: TInput,
  defaultTenantId: string,
): TInput & { tenantId: string } {
  return {
    ...input,
    tenantId: input.tenantId ?? defaultTenantId,
  };
}

export class EventService implements DatabaseEventsApi {
  constructor(
    private readonly driver: DatabaseEventDriver,
    private readonly defaultTenantId: string,
    private readonly defaultNodeId: string,
  ) {}

  append<TPayload extends DatabaseEventPayload>(
    input: DatabaseAppendEventInput<TPayload>,
  ): Promise<DatabaseEvent<TPayload>> {
    return this.driver.append({
      ...withTenantId(input, this.defaultTenantId),
      nodeId: input.nodeId ?? this.defaultNodeId,
    });
  }

  read(input: ReadDatabaseEventsInput = {}): Promise<DatabaseEvent[]> {
    return this.driver.read(withTenantId(input, this.defaultTenantId));
  }
}
