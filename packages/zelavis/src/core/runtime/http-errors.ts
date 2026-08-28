export interface ZelavisServerErrorStatusRule {
  matches: (error: unknown) => boolean;
  status: number;
}

export function createJsonErrorResponse(status: number, error: unknown) {
  return {
    status,
    body: {
      error: error instanceof Error ? error.message : String(error),
    },
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
