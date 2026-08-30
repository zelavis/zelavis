import {
  createErrorCorrelationId,
  genericErrorBody,
  publicErrorMessage,
} from "./error-policy.js";

export interface ZelavisServerErrorStatusRule {
  matches: (error: unknown) => boolean;
  status: number;
}

/**
 * Builds a JSON error response.
 *
 * A 4xx status means a mapping rule recognized this error as a problem with the
 * caller's request, so its message is about their input and is the useful half
 * of an API — validation and conflict messages stay verbatim.
 *
 * A 5xx status means nothing recognized the error. Its message was written for
 * whoever debugs it and routinely names filesystem paths, module specifiers,
 * SQL fragments, or internal service names, so it is replaced with a generic
 * body plus a correlation id — unless it is a typed domain error, whose message
 * is safe regardless of status.
 */
export function createJsonErrorResponse(status: number, error: unknown) {
  if (status < 500) {
    return {
      status,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const message = publicErrorMessage(error);
  if (message !== undefined) {
    return { status, body: { error: message } };
  }

  return {
    status,
    body: genericErrorBody(createErrorCorrelationId()),
  };
}

export function resolveMappedErrorStatus(
  error: unknown,
  rules: readonly ZelavisServerErrorStatusRule[],
  fallback = 500,
): number {
  for (const rule of rules) {
    if (rule.matches(error)) {
      return rule.status;
    }
  }

  return fallback;
}

export function createMappedJsonErrorResponse(
  error: unknown,
  rules: readonly ZelavisServerErrorStatusRule[],
  fallback = 500,
) {
  return createJsonErrorResponse(
    resolveMappedErrorStatus(error, rules, fallback),
    error,
  );
}
