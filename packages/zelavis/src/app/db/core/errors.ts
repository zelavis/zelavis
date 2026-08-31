export class DatabaseDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseDomainError";
  }
}

export class DatabaseValidationError extends DatabaseDomainError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseValidationError";
  }
}

export class DatabaseConflictError extends DatabaseDomainError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConflictError";
  }
}

export class DatabaseRevisionMismatchError extends DatabaseConflictError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseRevisionMismatchError";
  }
}

export class DatabaseNotFoundError extends DatabaseDomainError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseNotFoundError";
  }
}

export class DatabaseSchemaValidationError extends DatabaseDomainError {
  readonly collection: string;
  readonly schemaVersion: number;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(input: {
    collection: string;
    schemaVersion: number;
    issues: ReadonlyArray<{ path: string; message: string }>;
  }) {
    super(
      `Schema validation failed for collection "${input.collection}" version ${input.schemaVersion}: ${input.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join(", ")}`,
    );
    this.name = "DatabaseSchemaValidationError";
    this.collection = input.collection;
    this.schemaVersion = input.schemaVersion;
    this.issues = input.issues;
  }
}

export function isDatabaseDomainError(
  error: unknown,
): error is DatabaseDomainError {
  return error instanceof DatabaseDomainError;
}

/**
 * A write was attempted by a writer whose generation no longer owns the shard.
 *
 * Raised by the physical driver rather than by the router, so a superseded
 * writer that has not yet noticed it lost ownership — a partitioned process, a
 * paused one, a stale in-memory topology — is stopped by the database it is
 * trying to corrupt.
 */
export class DatabaseWriterFencedError extends DatabaseDomainError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseWriterFencedError";
  }
}
