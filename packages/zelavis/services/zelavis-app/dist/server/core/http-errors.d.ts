export interface ZelavisServerErrorStatusRule {
    matches: (error: unknown) => boolean;
    status: number;
}
export declare function createJsonErrorResponse(status: number, error: unknown): {
    status: number;
    body: {
        error: string;
    };
};
export declare function resolveMappedErrorStatus(error: unknown, rules: readonly ZelavisServerErrorStatusRule[], fallback?: number): number;
export declare function createMappedJsonErrorResponse(error: unknown, rules: readonly ZelavisServerErrorStatusRule[], fallback?: number): {
    status: number;
    body: {
        error: string;
    };
};
