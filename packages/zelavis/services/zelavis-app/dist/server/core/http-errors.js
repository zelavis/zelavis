export function createJsonErrorResponse(status, error) {
    return {
        status,
        body: {
            error: error instanceof Error ? error.message : String(error),
        },
    };
}
export function resolveMappedErrorStatus(error, rules, fallback = 500) {
    for (const rule of rules) {
        if (rule.matches(error)) {
            return rule.status;
        }
    }
    return fallback;
}
export function createMappedJsonErrorResponse(error, rules, fallback = 500) {
    return createJsonErrorResponse(resolveMappedErrorStatus(error, rules, fallback), error);
}
