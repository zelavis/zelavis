/**
 * Policy for turning a thrown value into a client response.
 *
 * Typed domain errors carry messages written for callers — "Project \"x\" was not
 * found", "Passwords must contain at least 15 characters" — and stay useful.
 * Everything else is an *unexpected* failure whose message was written for
 * whoever debugs it, and routinely contains filesystem paths, module
 * specifiers, SQL fragments, or internal service names. Those are replaced with
 * a generic message plus a correlation id, so an operator can still join the
 * response to the full cause in structured logs.
 */

/**
 * Errors whose message is safe to return.
 *
 * Matched on `name` rather than `instanceof` so an error crossing a module
 * boundary — or arriving from a plugin with its own copy of a class — is still
 * recognized.
 */
const PUBLIC_ERROR_NAMES: ReadonlySet<string> = new Set([
  // Platform
  "ZelavisProjectValidationError",
  "ZelavisProjectConflictError",
  "ZelavisProjectNotFoundError",
  "ZelavisProjectRuntimeError",
  "ZelavisProjectDeletionError",
  "ZelavisAssistantValidationError",
  "ZelavisAssistantNotFoundError",
  "ZelavisAuthenticationError",
  "ZelavisRequestBodyTooLargeError",
  // App Auth
  "IdentityDomainError",
  "IdentityValidationError",
  "IdentityNotFoundError",
  "AuthInvalidCredentialsError",
  "AuthRateLimitError",
  // App Database
  "DatabaseDomainError",
  "DatabaseValidationError",
  "DatabaseNotFoundError",
  "DatabaseConflictError",
  "DatabaseRevisionMismatchError",
  "DatabaseSchemaValidationError",
  "DatabaseEventIdempotencyConflictError",
  "DatabaseTopologyError",
  "DatabaseTopologyRouteError",
  "DatabaseTopologyValidationError",
  // Fabric
  "FabricInventoryError",
]);

export function isPublicZelavisError(error: unknown): error is Error {
  return error instanceof Error && PUBLIC_ERROR_NAMES.has(error.name);
}

/**
 * Returns the message safe to send for this error, or `undefined` when it must
 * be replaced with a generic one.
 */
export function publicErrorMessage(error: unknown): string | undefined {
  return isPublicZelavisError(error) ? error.message : undefined;
}

/**
 * Where an error whose message a caller must not see is recorded, with the id the caller does see. The
 * running Platform sets it (its log and the service journal); without one the cause is still written to
 * the console, so a reference the dashboard shows always leads to something.
 */
let unexpectedErrorSink: ((correlationId: string, error: unknown) => void) | undefined;

export function setUnexpectedErrorSink(sink: ((correlationId: string, error: unknown) => void) | undefined): void {
  unexpectedErrorSink = sink;
}

/** Records an error hidden behind `correlationId`; recording never fails the response. */
export function reportUnexpectedError(correlationId: string, error: unknown): void {
  if (unexpectedErrorSink) {
    unexpectedErrorSink(correlationId, error);
    return;
  }
  console.error(`Request failed (reference ${correlationId}):`, error);
}

/**
 * Short, unguessable id shared between a generic response and the logged cause.
 */
export function createErrorCorrelationId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface GenericErrorBody {
  readonly error: string;
  readonly correlationId: string;
}

export function genericErrorBody(correlationId: string): GenericErrorBody {
  return {
    error: "The request could not be completed.",
    correlationId,
  };
}
