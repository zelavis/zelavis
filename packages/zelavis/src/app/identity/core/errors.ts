export class IdentityDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityDomainError";
  }
}

export class IdentityValidationError extends IdentityDomainError {
  readonly _tag = "IdentityValidationError";

  constructor(message: string) {
    super(message);
    this.name = "IdentityValidationError";
  }
}

/**
 * A write lost a uniqueness race, or would break one.
 *
 * Raised by repositories, not the services: only the store can say "another
 * writer got there first" atomically, so callers translate this into their own
 * message instead of checking first and hoping nothing changed in between.
 */
export class IdentityConflictError extends IdentityValidationError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "IdentityConflictError";
    this.field = field;
  }
}

export class IdentityNotFoundError extends IdentityDomainError {
  readonly _tag = "IdentityNotFoundError";

  constructor(message: string) {
    super(message);
    this.name = "IdentityNotFoundError";
  }
}

export class AuthInvalidCredentialsError extends IdentityDomainError {
  readonly _tag = "AuthInvalidCredentialsError";

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

export class RegistrationError extends IdentityDomainError {
  constructor(
    readonly _tag: "RegistrationClosed" | "RegistrationSettingsConflict" | "RegistrationConflict" |
      "RegistrationBusy" | "RegistrationUnavailable" | "EnrollmentRequired",
    message: string,
  ) {
    super(message);
    this.name = _tag;
  }
}

export class RegistrationRateLimitError extends AuthRateLimitError {}

export class AccountAccessError extends IdentityDomainError {
  constructor(
    readonly _tag: "InvalidAccountAccess" | "AccountAccessForbidden" | "AccountNotFound" |
      "AccountAccessConflict" | "AccountAccessBusy" | "AccountAccessAuditFailed",
    message: string,
    readonly accessRevision?: number,
  ) {
    super(message);
    this.name = _tag;
  }
}
