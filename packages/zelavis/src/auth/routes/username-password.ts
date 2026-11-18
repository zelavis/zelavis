/**
 * The username + password routes (Zelavis-own): sign-up, sign-in and change password over
 * `setupUsernamePassword`. Failed attempts answer through `user-errors.ts`; a success that signs in answers through
 * `session-transport.ts`. Mounted under `/auth` by the runtime.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisServerRoute } from "../../core/index.js";
import type { UsernamePasswordMethod } from "../methods/username-password.js";
import { setPasswordUserError, verifyPasswordUserError } from "../password/validation.js";
import { setUsernameUserError } from "../username/validation.js";
import { errorBody, noStore, respond } from "./errors.js";
import { callOf } from "./core.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { assertUserErrorsCovered, userErrorResponse } from "./user-errors.js";

export interface UsernamePasswordRoutesOptions {
  readonly method: UsernamePasswordMethod;
  readonly transport: SessionTransport;
}

// A password may be 1024 characters of up to four bytes each, beside the username and the JSON around them.
const BODY_LIMIT = 16384;

const Credentials = Schema.Struct({ username: Schema.String, password: Schema.String });
const PasswordChange = Schema.Struct({ currentPassword: Schema.String, newPassword: Schema.String });
const SignUp = Schema.Struct({ ...Credentials.fields, displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))) });
const isSignUp = Schema.is(SignUp);
const isCredentials = Schema.is(Credentials);
const isPasswordChange = Schema.is(PasswordChange);

const invalidRequest = (message: string) => errorBody(400, "invalid_request", message);

const credentialsBody = {
  required: true,
  schema: { type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } } },
} as const;

export function defineUsernamePasswordRoutes(options: UsernamePasswordRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  // A code the methods can return without an HTTP answer is a defect at startup, not a 500 on a user's request.
  assertUserErrorsCovered(setUsernameUserError, setPasswordUserError, verifyPasswordUserError);
  const { method, transport } = options;

  return [
    {
      id: "auth.usernamePassword.signUp",
      method: "POST",
      path: "/username-password/sign-up",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "signUpWithUsernamePassword",
        summary: "Create an account with a username and password and sign in",
        tags: ["auth"],
        requestBody: { required: true, schema: Schema.toJsonSchemaDocument(SignUp).schema },
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          400: { description: "The username or password is not acceptable" },
          409: { description: "The username is taken" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isSignUp(context.body)) return invalidRequest("A username and a password are required.");
        const result = yield* method.signUpWithUsernamePassword(callOf(context), context.body);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.usernamePassword.signIn",
      method: "POST",
      path: "/username-password/sign-in",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "signInWithUsernamePassword",
        summary: "Sign in with a username and password",
        tags: ["auth"],
        requestBody: credentialsBody,
        responses: {
          200: { description: "Signed in: the token bundle, or cookies in a browser page of this origin" },
          401: { description: "The credentials are not correct" },
          404: { description: "There is no such account" },
          429: { description: "Too many attempts for this account; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isCredentials(context.body)) return invalidRequest("A username and a password are required.");
        const result = yield* method.signInWithUsernamePassword(callOf(context), context.body);
        return result.status === "error" ? userErrorResponse(result.userError) : signInResponse(transport, context.request, result);
      })),
    },
    {
      id: "auth.usernamePassword.changePassword",
      method: "POST",
      path: "/username-password/change-password",
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      // No `access`: the method answers `not_signed_in` itself, as it does for a signed-out caller of any method.
      spec: {
        operationId: "changePassword",
        summary: "Change the signed-in account's password and end its other sessions",
        tags: ["auth"],
        requestBody: {
          required: true,
          schema: { type: "object", required: ["currentPassword", "newPassword"], properties: { currentPassword: { type: "string" }, newPassword: { type: "string" } } },
        },
        responses: {
          200: { description: "The password changed" },
          400: { description: "The new password is not acceptable" },
          401: { description: "Not signed in, or the current password is not correct" },
          429: { description: "Too many attempts; see retry-after" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!isPasswordChange(context.body)) return invalidRequest("The current and the new password are required.");
        // Zelavis ends the account's other sessions on every change (upstream makes it optional).
        const result = yield* method.changePassword(callOf(context), { ...context.body, signOutOtherSessions: true });
        return result.success ? { status: 200, headers: noStore, body: { success: true } } : userErrorResponse(result.userError);
      })),
    },
  ];
}
