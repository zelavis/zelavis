export class AuthDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthDomainError";
  }
}

export class AuthValidationError extends AuthDomainError {
  constructor(message: string) {
    super(message);
    this.name = "AuthValidationError";
  }
}

export class AuthNotFoundError extends AuthDomainError {
  constructor(message: string) {
    super(message);
    this.name = "AuthNotFoundError";
  }
}

export class AuthInvalidCredentialsError extends AuthDomainError {
  constructor() {
    super("Invalid credentials.");
    this.name = "AuthInvalidCredentialsError";
  }
}

export class AuthRateLimitError extends AuthDomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many authentication attempts. Try again later.");
    this.name = "AuthRateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
