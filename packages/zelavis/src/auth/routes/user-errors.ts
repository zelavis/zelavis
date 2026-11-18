/**
 * The one table that turns a method's upstream `userError` into an HTTP answer (Zelavis-own).
 *
 * Every method route answers a failed attempt as `{ error: <message>, code: <snake_case of the upstream code> }`
 * with the status below, so clients, the SDK and the CLI read one vocabulary. A code a method can return but this
 * table lacks is a defect, found at startup by `assertUserErrorsCovered`, never as a 500 on a user's request.
 * Later parts add the codes of their methods here.
 */
import type { ZelavisRouteResponse } from "../../core/index.js";
import { errorBody } from "./errors.js";

interface UserErrorEntry {
  readonly status: number;
  readonly message: string;
}

const entry = (status: number, message: string): UserErrorEntry => ({ status, message });

/** Keyed by the upstream code. */
const USER_ERRORS: Readonly<Record<string, UserErrorEntry>> = {
  INVALID_CREDENTIALS: entry(401, "The credentials are not correct."),
  USER_NOT_FOUND: entry(404, "There is no account with these credentials."),
  RATE_LIMITED: entry(429, "Too many attempts; try again later."),
  NOT_LOGGED_IN: entry(401, "Not signed in."),
  USERNAME_TAKEN: entry(409, "That username is taken."),
  USERNAME_TOO_SHORT: entry(400, "The username is too short."),
  USERNAME_TOO_LONG: entry(400, "The username is too long."),
  USERNAME_HAS_SURROUNDING_WHITESPACE: entry(400, "The username must not start or end with whitespace."),
  USERNAME_HAS_INVALID_CHARACTERS: entry(400, "The username contains characters that are not allowed."),
  PASSWORD_TOO_SHORT: entry(400, "The password is too short."),
  PASSWORD_TOO_LONG: entry(400, "The password is too long."),
  PASSWORD_HAS_SURROUNDING_WHITESPACE: entry(400, "The password must not start or end with whitespace."),
  PASSWORD_TOO_COMMON: entry(400, "That password is too common."),
  INVALID_EMAIL: entry(400, "That is not a valid email address."),
  EMAIL_TAKEN: entry(409, "That email address belongs to another account."),
  EMAIL_NOT_FOUND: entry(404, "No account has verified that email address."),
  EMAIL_UNAVAILABLE: entry(409, "Email delivery is not available on this runtime."),
  INVALID_CHALLENGE: entry(400, "The link is not valid any more; start again."),
  INCORRECT_CODE: entry(400, "The code does not match the link this browser started; open the newest email."),
  WRONG_USER: entry(403, "This link was started by another account."),
  UNKNOWN_PROVIDER: entry(404, "That sign-in provider is not connected."),
  INVALID_REDIRECT: entry(400, "That redirect destination is not allowed."),
  INVALID_CODE: entry(400, "The sign-in ticket is not valid any more; start again."),
  PROVIDER_ACCOUNT_IN_USE: entry(409, "That provider account is connected to another account."),
  CHALLENGE_EXPIRED: entry(400, "The passkey challenge expired or was already used. Start again."),
  UNKNOWN_CREDENTIAL: entry(404, "This passkey is unavailable for sign-in."),
  PROTOCOL_ERROR: entry(400, "The passkey response could not be verified."),
  CREDENTIAL_ALREADY_REGISTERED: entry(409, "This passkey is already registered."),
  TOO_MANY_PASSKEYS: entry(409, "This account already has the maximum number of passkeys."),
  PASSKEY_NOT_FOUND: entry(404, "That passkey does not exist."),
  LAST_PASSKEY: entry(409, "You need another passkey to confirm removal."),
  INVALID_PASSKEY_NAME: entry(400, "Use a visible passkey name of 1 to 50 characters."),
  NO_PENDING_ENROLLMENT: entry(409, "There is no authenticator waiting for confirmation; start the setup again."),
  TOO_MANY_TOTPS: entry(409, "This account already has the maximum number of authenticators; remove one first."),
  TOTP_NOT_FOUND: entry(404, "That authenticator does not exist."),
  MFA_NOT_ENABLED: entry(409, "This account has no authenticator."),
  MFA_CODE_REQUIRED: entry(401, "Give a current code from an existing authenticator or an unused backup code."),
  MFA_REQUIRED_BY_POLICY: entry(409, "The MFA policy requires this account to keep an authenticator."),
  REAUTHENTICATION_REQUIRED: entry(401, "Confirm it is you: give your current password, or sign in again."),
};

/** The `error` literals of a `userError` Schema: a union of structs, or a union of unions, each with an `error` literal. */
export const userErrorCodesOf = (schema: unknown): ReadonlyArray<string> => {
  // A Schema is an object or, for a struct, a function carrying its members.
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) return [];
  const { members, fields } = schema as { members?: unknown; fields?: unknown };
  if (Array.isArray(members)) return members.flatMap(userErrorCodesOf);
  if (typeof fields === "object" && fields !== null && "error" in fields) {
    const literal = (fields.error as { literal?: unknown }).literal;
    return typeof literal === "string" ? [literal] : [];
  }
  return [];
};

/** Fails when a method's `userError` Schema declares a code the table lacks. Run when routes are defined. */
export const assertUserErrorsCovered = (...schemas: ReadonlyArray<unknown>): void => {
  const found = schemas.flatMap(userErrorCodesOf);
  if (found.length === 0) throw new Error("assertUserErrorsCovered found no error codes: the Schema shape is not the one it reads");
  const missing = found.filter((code) => !Object.hasOwn(USER_ERRORS, code));
  if (missing.length > 0) throw new Error(`Auth user errors without an HTTP mapping: ${[...new Set(missing)].join(", ")}`);
};

/** `NOT_LOGGED_IN` reads `not_signed_in` on the wire, as the session routes say it. */
const wireCode = (code: string) => (code === "NOT_LOGGED_IN" ? "not_signed_in" : code.toLowerCase());

export interface UserError {
  readonly error: string;
  readonly retryAfterMs?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
}

export const userErrorResponse = (userError: UserError): ZelavisRouteResponse => {
  const known = USER_ERRORS[userError.error];
  if (known === undefined) {
    return errorBody(500, "unmapped_user_error", "An unexpected error occurred.");
  }
  const base = errorBody(
    known.status,
    wireCode(userError.error),
    known.message,
    userError.retryAfterMs === undefined ? {} : { "retry-after": String(Math.max(1, Math.ceil(userError.retryAfterMs / 1000))) },
  );
  const extra = {
    ...(userError.minimumLength === undefined ? {} : { minimumLength: userError.minimumLength }),
    ...(userError.maximumLength === undefined ? {} : { maximumLength: userError.maximumLength }),
    ...(userError.retryAfterMs === undefined ? {} : { retryAfterMs: userError.retryAfterMs }),
  };
  return { ...base, body: { ...(base.body as object), ...extra } };
};
