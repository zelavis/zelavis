export class DatabaseDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseDomainError";
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

export function isDatabaseDomainError(
  error: unknown,
): error is DatabaseDomainError {
  return error instanceof DatabaseDomainError;
}
