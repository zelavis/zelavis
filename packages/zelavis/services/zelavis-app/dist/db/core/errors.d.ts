export declare class DatabaseDomainError extends Error {
    constructor(message: string);
}
export declare class DatabaseValidationError extends DatabaseDomainError {
    constructor(message: string);
}
export declare class DatabaseConflictError extends DatabaseDomainError {
    constructor(message: string);
}
export declare class DatabaseRevisionMismatchError extends DatabaseConflictError {
    constructor(message: string);
}
export declare class DatabaseNotFoundError extends DatabaseDomainError {
    constructor(message: string);
}
export declare class DatabaseSchemaValidationError extends DatabaseDomainError {
    readonly collection: string;
    readonly schemaVersion: number;
    readonly issues: ReadonlyArray<{
        path: string;
        message: string;
    }>;
    constructor(input: {
        collection: string;
        schemaVersion: number;
        issues: ReadonlyArray<{
            path: string;
            message: string;
        }>;
    });
}
export declare function isDatabaseDomainError(error: unknown): error is DatabaseDomainError;
