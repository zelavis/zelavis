import { DatabaseConflictError } from "../core/errors.js";
export class DatabaseEventIdempotencyConflictError extends DatabaseConflictError {
    tenantId;
    idempotencyKey;
    eventId;
    constructor(input) {
        super(`Idempotency key "${input.idempotencyKey}" for tenant "${input.tenantId}" is already bound to event "${input.eventId}" with different append input.`);
        this.name = "DatabaseEventIdempotencyConflictError";
        this.tenantId = input.tenantId;
        this.idempotencyKey = input.idempotencyKey;
        this.eventId = input.eventId;
    }
}
