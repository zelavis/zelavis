/**
 * The email + password routes and the account's email addresses (Zelavis-own): sign-up with verification, sign-in,
 * change password, change email, recovery and add-email over `setupEmailPassword`. Failed attempts answer through
 * `user-errors.ts`; a success that signs in answers through `session-transport.ts`. Mounted under `/auth` by the
 * runtime.
 *
 * A start answers `{ browserSecret }`, which only the starting browser may keep; the emailed link carries the other
 * half of the proof (its code) in the URL fragment.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisServerRoute } from "../../core/index.js";
import {
  completeChallengeUserError,
  completeFreeAddressUserError,
  emailNotFoundUserError,
  startChallengeUserError,
  startFreeAddressUserError,
  wrongUserUserError,
} from "../email/validation.js";
import { type EmailPasswordMethod, emailUnavailableUserError } from "../methods/email-password.js";
import { setPasswordUserError, verifyPasswordUserError } from "../password/validation.js";
import { errorBody, noStore, respond } from "./errors.js";
import { callOf } from "./core.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { assertUserErrorsCovered, userErrorResponse } from "./user-errors.js";

export interface EmailRoutesOptions {
  readonly method: EmailPasswordMethod;
  readonly transport: SessionTransport;
}

// A password may be 1024 characters of up to four bytes each, beside the address and the JSON around them.
const PASSWORD_BODY_LIMIT = 16384;
const BODY_LIMIT = 4096;

const EmailPassword = Schema.Struct({ email: Schema.String, password: Schema.String });
const PasswordChange = Schema.Struct({ currentPassword: Schema.String, newPassword: Schema.String });
const ChangeEmailStart = Schema.Struct({ newEmail: Schema.String, password: Schema.String });
const Claim = Schema.Struct({ emailCode: Schema.String, browserSecret: Schema.String });
const Recovery = Schema.Struct({ email: Schema.String });
const RecoveryComplete = Schema.Struct({ emailCode: Schema.String, browserSecret: Schema.String, newPassword: Schema.String });
const AddStart = Schema.Struct({ email: Schema.String });
const SignUp = Schema.Struct({ ...EmailPassword.fields, displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))) });
const isSignUp = Schema.is(SignUp);
const isEmailPassword = Schema.is(EmailPassword);
const isPasswordChange = Schema.is(PasswordChange);
const isChangeEmailStart = Schema.is(ChangeEmailStart);
const isClaim = Schema.is(Claim);
const isRecovery = Schema.is(Recovery);
const isRecoveryComplete = Schema.is(RecoveryComplete);
const isAddStart = Schema.is(AddStart);

const invalidRequest = (message: string) => errorBody(400, "invalid_request", message);

const obj = (required: ReadonlyArray<string>) =>
  ({ type: "object", required, properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])) }) as const;
const body = (required: ReadonlyArray<string>) => ({ required: true, schema: obj(required) }) as const;

const started = (browserSecret: string) => ({ status: 200, headers: noStore, body: { browserSecret } });

export function defineEmailRoutes(options: EmailRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  // A code the methods can return without an HTTP answer is a defect at startup, not a 500 on a user's request.
  assertUserErrorsCovered(
    startFreeAddressUserError,
    startChallengeUserError,
    completeChallengeUserError,
    completeFreeAddressUserError,
    wrongUserUserError,
    emailNotFoundUserError,
    emailUnavailableUserError,
    setPasswordUserError,
    verifyPasswordUserError,
  );
  const { method, transport } = options;

  return [
    {
      id: "auth.emailPassword.signUp",
      method: "POST",
      path: "/email-password/sign-up",
      maxRequestBodyBytes: PASSWORD_BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "signUpWithEmailPassword",
        summary: "Create an account with an email address and a password and send the verification link",
        tags: ["auth"],
        requestBody: { required: true, schema: Schema.toJsonSchemaDocument(SignUp).schema },
        responses: {
          200: { description: "The link was sent; the browser keeps the returned browserSecret" },
          400: { description: "The address or password is not acceptable" },
          409: { description: "The address belongs to an account, or email delivery is not available" },
          429: { description: "Too many attempts from this client or for this address; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isSignUp(context.body)) return invalidRequest("An email address and a password are required.");
        const result = yield* method.signUpWithEmailPassword(callOf(context), context.body);
        return result.success ? started(result.browserSecret) : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emailPassword.completeSignUp",
      method: "POST",
      path: "/email-password/complete-sign-up",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "completeSignUpWithEmailPassword",
        summary: "Verify the address with the emailed code and the browser secret, and sign in",
        tags: ["auth"],
        requestBody: body(["emailCode", "browserSecret"]),
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          400: { description: "The link is not valid, or the code does not match" },
          409: { description: "Another account verified the address first" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isClaim(context.body)) return invalidRequest("A code and a browser secret are required.");
        const result = yield* method.completeSignUpWithEmailPassword(callOf(context), context.body);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.emailPassword.signIn",
      method: "POST",
      path: "/email-password/sign-in",
      maxRequestBodyBytes: PASSWORD_BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "signInWithEmailPassword",
        summary: "Sign in with a verified email address and a password",
        tags: ["auth"],
        requestBody: body(["email", "password"]),
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          401: { description: "The credentials are not correct" },
          404: { description: "No account has verified this address" },
          429: { description: "Too many attempts from this client or for this account; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isEmailPassword(context.body)) return invalidRequest("An email address and a password are required.");
        const result = yield* method.signInWithEmailPassword(callOf(context), context.body);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.emailPassword.changePassword",
      method: "POST",
      path: "/email-password/change-password",
      maxRequestBodyBytes: PASSWORD_BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      // No `access`: the method answers `not_signed_in` itself, as it does for a signed-out caller of any method.
      spec: {
        operationId: "changeEmailPassword",
        summary: "Change the signed-in account's password and end its other sessions",
        tags: ["auth"],
        requestBody: body(["currentPassword", "newPassword"]),
        responses: {
          200: { description: "The password changed" },
          400: { description: "The new password is not acceptable" },
          401: { description: "Not signed in, or the current password is not correct" },
          429: { description: "Too many attempts; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isPasswordChange(context.body)) return invalidRequest("The current and the new password are required.");
        const result = yield* method.changePassword(callOf(context), { ...context.body, signOutOtherSessions: true });
        return result.success ? { status: 200, headers: noStore, body: { success: true } } : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emailPassword.changeEmailStart",
      method: "POST",
      path: "/email-password/change-email/start",
      maxRequestBodyBytes: PASSWORD_BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "startChangeEmail",
        summary: "Send a link to a new address; the signed-in account's password is required",
        tags: ["auth"],
        requestBody: body(["newEmail", "password"]),
        responses: {
          200: { description: "The link was sent; the browser keeps the returned browserSecret" },
          400: { description: "The address is not acceptable" },
          401: { description: "Not signed in, or the password is not correct" },
          409: { description: "The address belongs to an account, or email delivery is not available" },
          429: { description: "Too many attempts; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isChangeEmailStart(context.body)) return invalidRequest("A new email address and the password are required.");
        const result = yield* method.startChangeEmail(callOf(context), { newEmail: context.body.newEmail, currentPassword: context.body.password });
        return result.success ? started(result.browserSecret) : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emailPassword.changeEmailComplete",
      method: "POST",
      path: "/email-password/change-email/complete",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "completeChangeEmail",
        summary: "Make the verified new address the primary one; the account that started the change must be signed in",
        tags: ["auth"],
        requestBody: body(["emailCode", "browserSecret"]),
        responses: {
          200: { description: "The address changed" },
          400: { description: "The link is not valid, or the code does not match" },
          401: { description: "Not signed in" },
          403: { description: "The link was started by another account" },
          409: { description: "Another account verified the address first" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isClaim(context.body)) return invalidRequest("A code and a browser secret are required.");
        const result = yield* method.completeChangeEmail(callOf(context), context.body);
        return result.success ? { status: 200, headers: noStore, body: { success: true } } : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emailPassword.recoveryStart",
      method: "POST",
      path: "/email-password/recovery/start",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "startPasswordRecovery",
        summary: "Send a password reset link to a verified address",
        tags: ["auth"],
        requestBody: body(["email"]),
        responses: {
          200: { description: "The link was sent; the browser keeps the returned browserSecret" },
          404: { description: "No account has verified this address" },
          409: { description: "Email delivery is not available" },
          429: { description: "Too many attempts from this client or for this address; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isRecovery(context.body)) return invalidRequest("An email address is required.");
        const result = yield* method.startPasswordRecovery(callOf(context), context.body);
        return result.success ? started(result.browserSecret) : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emailPassword.recoveryCheck",
      method: "POST",
      path: "/email-password/recovery/check",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "checkPasswordRecovery",
        summary: "Tell whether a reset link would be accepted, without using it up",
        tags: ["auth"],
        requestBody: body(["emailCode", "browserSecret"]),
        responses: { 200: { description: "{ valid: boolean }" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isClaim(context.body)) return invalidRequest("A code and a browser secret are required.");
        const result = yield* method.checkPasswordRecovery(callOf(context), context.body);
        return { status: 200, headers: noStore, body: { valid: result.success } };
      })),
    },
    {
      id: "auth.emailPassword.recoveryComplete",
      method: "POST",
      path: "/email-password/recovery/complete",
      maxRequestBodyBytes: PASSWORD_BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "completePasswordRecovery",
        summary: "Set a new password with a reset link, end every session of the account and sign in",
        tags: ["auth"],
        requestBody: body(["emailCode", "browserSecret", "newPassword"]),
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          400: { description: "The link is not valid, the code does not match, or the password is not acceptable" },
          429: { description: "Too many recovery attempts from this client; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isRecoveryComplete(context.body)) return invalidRequest("A code, a browser secret and a new password are required.");
        const result = yield* method.completePasswordRecovery(callOf(context), context.body);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.emails.list",
      method: "GET",
      path: "/emails",
      spec: {
        operationId: "listEmails",
        summary: "The signed-in account's verified email addresses",
        tags: ["auth"],
        responses: { 200: { description: "{ emails: [{ email, isPrimary }] }" }, 401: { description: "Not signed in" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const emails = yield* method.listEmails(callOf(context));
        return emails === null ? userErrorResponse({ error: "NOT_LOGGED_IN" }) : { status: 200, headers: noStore, body: { emails } };
      })),
    },
    {
      id: "auth.emails.addStart",
      method: "POST",
      path: "/emails/add/start",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "startAddEmail",
        summary: "Send a verification link to an address to add to the signed-in account",
        tags: ["auth"],
        requestBody: body(["email"]),
        responses: {
          200: { description: "The link was sent; the browser keeps the returned browserSecret" },
          400: { description: "The address is not acceptable" },
          401: { description: "Not signed in" },
          409: { description: "The address belongs to an account, or email delivery is not available" },
          429: { description: "Too many attempts; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isAddStart(context.body)) return invalidRequest("An email address is required.");
        const result = yield* method.startAddEmail(callOf(context), context.body);
        return result.success ? started(result.browserSecret) : userErrorResponse(result.userError);
      })),
    },
    {
      id: "auth.emails.addComplete",
      method: "POST",
      path: "/emails/add/complete",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "completeAddEmail",
        summary: "Add the verified address to the signed-in account",
        tags: ["auth"],
        requestBody: body(["emailCode", "browserSecret"]),
        responses: {
          200: { description: "The address was added" },
          400: { description: "The link is not valid, or the code does not match" },
          401: { description: "Not signed in" },
          403: { description: "The link was started by another account" },
          409: { description: "Another account verified the address first" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isClaim(context.body)) return invalidRequest("A code and a browser secret are required.");
        const result = yield* method.completeAddEmail(callOf(context), context.body);
        return result.success ? { status: 200, headers: noStore, body: { success: true } } : userErrorResponse(result.userError);
      })),
    },
  ];
}
