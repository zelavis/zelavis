/**
 * The MFA routes (Zelavis-own): TOTP enrollment, the second step of a gated sign-in, the signed-in account's
 * authenticators and backup codes, and the runtime's MFA policy, over `setupMfa`. Mounted under `/auth`.
 *
 * `POST /mfa/verify` and an enrollment confirmed with an `enroll` challenge sign in, so they answer through
 * `session-transport.ts`. `DELETE /auth/accounts/:accountId/mfa` (an administrator's reset, with its delegation check)
 * is in `admin.ts`; `resetSecondFactor` in `totp/policy.ts` is what it calls.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisAccessRequirement, ZelavisRouteContext, ZelavisRouteResponse, ZelavisServerRoute } from "../../core/index.js";
import type { AuthCall } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import {
  type MfaMethod,
  confirmEnrollmentUserError,
  manageUserError,
  startEnrollmentUserError,
  verifyPendingUserError,
} from "../methods/totp.js";
import { MfaPolicyInput } from "../totp/policy.js";
import { callOf } from "./core.js";
import { errorBody, noStore, respond } from "./errors.js";
import { type SessionTransport, signInResponse } from "./session-transport.js";
import { assertUserErrorsCovered, type UserError, userErrorResponse } from "./user-errors.js";

const BODY_LIMIT = 16 * 1024;
const Code = Schema.String.check(Schema.isMaxLength(64));
const Challenge = Schema.String.check(Schema.isMaxLength(128));
const TotpId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
const StartBody = Schema.Struct({ password: Schema.optional(Schema.String), challenge: Schema.optional(Challenge), code: Schema.optional(Code) });
const ConfirmBody = Schema.Struct({ totpId: TotpId, code: Code, challenge: Schema.optional(Challenge) });
const VerifyBody = Schema.Struct({ challenge: Challenge, code: Code });
const CodeBody = Schema.Struct({ code: Code });

const ok = (body: unknown): ZelavisRouteResponse => ({ status: 200, headers: noStore, body });
const invalidBody = () => errorBody(400, "invalid_request", "The MFA request body is invalid.");

// The shared table words these two for email links; a second factor is a code typed from an authenticator.
const MFA_USER_ERRORS: Readonly<Record<string, readonly [number, string]>> = {
  INCORRECT_CODE: [400, "The code is not correct, or it was used already."],
  INVALID_CHALLENGE: [400, "This sign-in step expired or ended; sign in again."],
};

const mfaUserErrorResponse = (userError: UserError): ZelavisRouteResponse => {
  const own = MFA_USER_ERRORS[userError.error];
  return own === undefined ? userErrorResponse(userError) : errorBody(own[0], userError.error.toLowerCase(), own[1]);
};

type Failed = { readonly success: false; readonly userError: UserError };
const isFailed = (result: unknown): result is Failed =>
  typeof result === "object" && result !== null && (result as { success?: unknown }).success === false;

export function defineMfaRoutes({ method, transport, settingsAccess }: {
  method: MfaMethod;
  transport: SessionTransport;
  settingsAccess: ZelavisAccessRequirement;
}): ReadonlyArray<ZelavisServerRoute> {
  assertUserErrorsCovered(startEnrollmentUserError, confirmEnrollmentUserError, manageUserError, verifyPendingUserError);

  const route = <A>(
    spec: { id: string; operationId: string; summary: string; method: "GET" | "POST" | "DELETE" | "PUT"; path: string; responses: Record<number, string> },
    body: Schema.Codec<A> | undefined,
    run: (call: AuthCall, input: A, context: ZelavisRouteContext) => Effect.Effect<ZelavisRouteResponse, AuthFailure>,
    access?: ZelavisAccessRequirement,
  ): ZelavisServerRoute => ({
    id: spec.id,
    method: spec.method,
    path: spec.path,
    ...(access === undefined ? {} : { access }),
    ...(body === undefined ? {} : { maxRequestBodyBytes: BODY_LIMIT, invalidJsonBodyCode: "invalid_request" }),
    spec: {
      operationId: spec.operationId,
      summary: spec.summary,
      tags: ["auth"],
      ...(spec.path.includes(":totpId") ? { pathParams: { totpId: { type: "string" } } } : {}),
      ...(body === undefined ? {} : { requestBody: { required: true, schema: Schema.toJsonSchemaDocument(body).schema } }),
      responses: Object.fromEntries(Object.entries(spec.responses).map(([status, description]) => [status, { description }])),
    },
    handler: (context) => respond(Effect.gen(function* () {
      if (body === undefined) return yield* run(callOf(context), undefined as A, context);
      const input = Schema.decodeUnknownOption(body)(context.body);
      if (input._tag === "None") return invalidBody();
      return yield* run(callOf(context), input.value, context);
    })),
  });

  const answer = (result: unknown): ZelavisRouteResponse => (isFailed(result) ? mfaUserErrorResponse(result.userError) : ok(result));

  return [
    route(
      { id: "auth.mfa.totp.start", operationId: "startTotpEnrollment", summary: "Start enrolling a TOTP authenticator", method: "POST", path: "/mfa/totp",
        responses: { 200: "The enrollment ID, new secret and otpauth URI", 400: "Invalid request, challenge or code", 401: "Sign-in or re-authentication required", 429: "Too many attempts" } },
      StartBody,
      (call, input) => Effect.map(method.startEnrollment(call, input), answer),
    ),
    route(
      { id: "auth.mfa.totp.confirm", operationId: "confirmTotpEnrollment", summary: "Confirm a TOTP authenticator with a code", method: "POST", path: "/mfa/totp/confirm",
        responses: { 200: "The authenticator is active; with a challenge, also signed in", 400: "Incorrect code or invalid challenge", 401: "Sign-in required", 409: "No matching enrollment, or too many authenticators", 429: "Too many wrong codes" } },
      ConfirmBody,
      (call, input, context) => Effect.map(method.confirmEnrollment(call, input), (result) => {
        if (!result.success) return mfaUserErrorResponse(result.userError);
        const confirmed = { totpId: result.totpId, ...(result.backupCodes === undefined ? {} : { backupCodes: result.backupCodes }) };
        return result.signIn === undefined ? ok({ success: true, ...confirmed }) : signInResponse(transport, context.request, result.signIn, confirmed);
      }),
    ),
    route(
      { id: "auth.mfa.verify", operationId: "verifyMfa", summary: "Complete a sign-in with a TOTP or backup code", method: "POST", path: "/mfa/verify",
        responses: { 200: "Signed in: the token bundle, or cookies in a browser page of this origin", 400: "Incorrect code or invalid challenge", 429: "Too many wrong codes for this account" } },
      VerifyBody,
      (call, input, context) => Effect.map(method.verify(call, input), (result) =>
        "status" in result ? signInResponse(transport, context.request, result) : mfaUserErrorResponse(result.userError)),
    ),
    route(
      { id: "auth.mfa.status", operationId: "getMfaStatus", summary: "The signed-in account's authenticators and remaining backup codes", method: "GET", path: "/mfa",
        responses: { 200: "MFA status", 401: "Sign-in required" } },
      undefined,
      (call) => Effect.map(method.status(call), answer),
    ),
    route(
      { id: "auth.mfa.totp.remove", operationId: "removeTotp", summary: "Remove an authenticator, given a current code", method: "DELETE", path: "/mfa/totp/:totpId",
        responses: { 200: "Removed", 400: "Incorrect code", 401: "Sign-in required", 404: "No such authenticator", 409: "The MFA policy requires an authenticator", 429: "Too many wrong codes" } },
      CodeBody,
      (call, input, context) => Effect.map(method.removeTotp(call, { totpId: context.params.totpId ?? "", code: input.code }), answer),
    ),
    route(
      { id: "auth.mfa.backupCodes.regenerate", operationId: "regenerateBackupCodes", summary: "Replace the backup codes, given a current code", method: "POST", path: "/mfa/backup-codes",
        responses: { 200: "The new backup codes, shown once", 400: "Incorrect code", 401: "Sign-in required", 409: "No authenticator", 429: "Too many wrong codes" } },
      CodeBody,
      (call, input) => Effect.map(method.regenerateBackupCodes(call, input), answer),
    ),
    route(
      { id: "auth.mfa.policy.get", operationId: "getMfaPolicy", summary: "Read the MFA policy", method: "GET", path: "/mfa/policy", responses: { 200: "The MFA policy" } },
      undefined,
      (call) => Effect.map(method.policy.get(call), ok),
      settingsAccess,
    ),
    route(
      { id: "auth.mfa.policy.set", operationId: "setMfaPolicy", summary: "Set the MFA policy", method: "PUT", path: "/mfa/policy",
        responses: { 200: "The saved MFA policy", 400: "Invalid policy", 409: "The policy changed since expectedRevision" } },
      MfaPolicyInput,
      (call, input) => Effect.map(method.policy.set(call, input), (result) =>
        result.success ? ok(result.policy) : { ...errorBody(409, "mfa_policy_conflict", "The MFA policy changed; read it again."), body: { error: "The MFA policy changed; read it again.", code: "mfa_policy_conflict", policy: result.conflict } }),
      settingsAccess,
    ),
  ];
}
