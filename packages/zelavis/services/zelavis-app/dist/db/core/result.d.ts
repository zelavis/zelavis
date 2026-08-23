export type Result<TValue, TError> = {
    ok: true;
    value: TValue;
} | {
    ok: false;
    error: TError;
};
export declare function ok<TValue>(value: TValue): Result<TValue, never>;
export declare function err<TError>(error: TError): Result<never, TError>;
