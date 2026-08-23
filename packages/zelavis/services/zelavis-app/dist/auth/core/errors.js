export class AuthDomainError extends Error {
    constructor(message) {
        super(message);
        this.name = "AuthDomainError";
    }
}
export class AuthValidationError extends AuthDomainError {
    constructor(message) {
        super(message);
        this.name = "AuthValidationError";
    }
}
export class AuthNotFoundError extends AuthDomainError {
    constructor(message) {
        super(message);
        this.name = "AuthNotFoundError";
    }
}
