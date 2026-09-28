export class IdentityDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityDomainError";
  }
}

export class IdentityValidationError extends IdentityDomainError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityValidationError";
  }
}

export class IdentityNotFoundError extends IdentityDomainError {
  constructor(message: string) {
    super(message);
    this.name = "IdentityNotFoundError";
  }
}

export class AuthInvalidCredentialsError extends IdentityDomainError {
  constructor() {
    super("Invalid credentials.");
    this.name = "AuthInvalidCredentialsError";
  }
}

export class AuthRateLimitError extends IdentityDomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many authentication attempts. Try again later.");
    this.name = "AuthRateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
