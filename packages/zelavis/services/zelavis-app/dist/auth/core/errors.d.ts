export declare class AuthDomainError extends Error {
    constructor(message: string);
}
export declare class AuthValidationError extends AuthDomainError {
    constructor(message: string);
}
export declare class AuthNotFoundError extends AuthDomainError {
    constructor(message: string);
}
