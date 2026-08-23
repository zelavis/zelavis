export class DatabaseDomainError extends Error {
    constructor(message) {
        super(message);
        this.name = "DatabaseDomainError";
    }
}
export class DatabaseValidationError extends DatabaseDomainError {
    constructor(message) {
        super(message);
        this.name = "DatabaseValidationError";
    }
}
export class DatabaseConflictError extends DatabaseDomainError {
    constructor(message) {
        super(message);
        this.name = "DatabaseConflictError";
    }
}
export class DatabaseRevisionMismatchError extends DatabaseConflictError {
    constructor(message) {
        super(message);
        this.name = "DatabaseRevisionMismatchError";
    }
}
export class DatabaseNotFoundError extends DatabaseDomainError {
    constructor(message) {
        super(message);
        this.name = "DatabaseNotFoundError";
    }
}
export class DatabaseSchemaValidationError extends DatabaseDomainError {
    collection;
    schemaVersion;
    issues;
    constructor(input) {
        super(`Schema validation failed for collection "${input.collection}" version ${input.schemaVersion}: ${input.issues
            .map((issue) => `${issue.path} ${issue.message}`)
            .join(", ")}`);
        this.name = "DatabaseSchemaValidationError";
        this.collection = input.collection;
        this.schemaVersion = input.schemaVersion;
        this.issues = input.issues;
    }
}
export function isDatabaseDomainError(error) {
    return error instanceof DatabaseDomainError;
}
