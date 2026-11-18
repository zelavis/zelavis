import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ZelavisAccessRequirement, ZelavisRouteContext, ZelavisServerRoute } from "../../core/index.js";
import type { AuthCall } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import type { RegistrationRefused } from "../registration/errors.js";
import type { SignInComplete } from "../lib/types.js";
import type { UsernamePasskeyMethod } from "../methods/username-passkey/server.js";
import { PasskeySettingsInput, type PasskeySettings } from "../passkey/settings.js";
import { AuthenticationResponse, RegistrationResponse } from "../passkey/validation.js";
import { callOf } from "./core.js";
import { errorBody, noStore, respond } from "./errors.js";
import { signInResponse, type SessionTransport } from "./session-transport.js";
import { userErrorResponse, type UserError } from "./user-errors.js";

const BODY_LIMIT = 16 * 1024;
const Username = Schema.Struct({ username: Schema.String });
const FlowId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const Assertion = Schema.Struct({ flowId: FlowId, response: AuthenticationResponse });
const Registration = Schema.Struct({ flowId: FlowId, response: RegistrationResponse });
const Rename = Schema.Struct({ name: Schema.String });

const ok = (body: unknown) => ({ status: 200, headers: noStore, body });
const invalidBody = () => errorBody(400, "invalid_request", "The passkey request body is invalid.");
const invalidSettings = () => errorBody(400, "invalid_passkey_settings", "Set a relying-party ID, name, and matching secure origins.");

type Result = SignInComplete | { readonly success: true } | { readonly success: false; readonly userError: UserError };

export function definePasskeyRoutes({ method, transport, settings, settingsAccess }: {
  method: UsernamePasskeyMethod;
  transport: SessionTransport;
  settings: PasskeySettings;
  settingsAccess: ZelavisAccessRequirement;
}): ReadonlyArray<ZelavisServerRoute> {
  const answer = (result: Result, request: Request) => {
    if ("status" in result) return signInResponse(transport, request, result);
    return result.success ? ok(result) : userErrorResponse(result.userError);
  };

  const post = <A>(
    operationId: string, path: string, summary: string,
    run: (call: AuthCall, input: A, context: ZelavisRouteContext) => Effect.Effect<Result, AuthFailure | RegistrationRefused>,
    body: Schema.Codec<A>,
    httpMethod: "POST" | "PATCH" = "POST",
  ): ZelavisServerRoute => {
    const hasBody = body !== Schema.Undefined;
    return {
      id: `auth.${path.startsWith("/username-passkey/") ? "usernamePasskey" : "passkeys"}.${operationId}`,
      method: httpMethod,
      path,
      maxRequestBodyBytes: BODY_LIMIT,
      invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId, summary, tags: ["auth"],
        ...(path.includes(":passkeyId") ? { pathParams: { passkeyId: { type: "string" } } } : {}),
        ...(hasBody ? { requestBody: { required: true, schema: Schema.toJsonSchemaDocument(body).schema } } : {}),
        responses: {
          200: { description: "Passkey operation completed" }, 400: { description: "Invalid request or ceremony" },
          401: { description: "Sign-in required" }, 404: { description: "Passkey or account unavailable" },
          409: { description: "Enrollment or removal conflict" }, 429: { description: "Too many attempts" },
        },
      },
      handler: (context) => respond(Effect.gen(function* () {
        if (!(yield* settings.available(context.request))) return errorBody(404, "passkeys_unavailable", "Passkeys are unavailable for this runtime.");
        const input = Schema.decodeUnknownOption(body)(hasBody ? context.body : undefined);
        if (input._tag === "None") return invalidBody();
        return answer(yield* run(callOf(context), input.value, context), context.request);
      })),
    };
  };

  return [
    post("startUsernamePasskeySignUp", "/username-passkey/sign-up/start", "Start registering a username and passkey", (call, input) => method.startSignUp(call, input.username), Username),
    post("finishUsernamePasskeySignUp", "/username-passkey/sign-up/finish", "Verify registration and sign in", method.finishSignUp, Registration),
    post("startUsernamePasskeySignIn", "/username-passkey/sign-in/start", "Start passkey sign-in for a username", (call, input) => method.startSignIn(call, input.username), Username),
    post("startAutofillPasskeySignIn", "/username-passkey/sign-in/autofill", "Start discoverable passkey sign-in", method.startAutofill, Schema.Undefined),
    post("finishUsernamePasskeySignIn", "/username-passkey/sign-in/finish", "Verify a passkey assertion and sign in", method.finishSignIn, Assertion),
    {
      id: "auth.passkeys.list", method: "GET", path: "/passkeys",
      spec: { operationId: "listPasskeys", summary: "List the signed-in account's passkeys", tags: ["auth"], responses: { 200: { description: "Passkeys" }, 401: { description: "Sign-in required" } } },
      handler: (context) => respond(Effect.map(method.list(callOf(context)), (result) => answer(result, context.request))),
    },
    post("startAddPasskey", "/passkeys/add/start", "Start passkey re-authentication", method.startAdd, Schema.Undefined),
    post("verifyAddPasskey", "/passkeys/add/verify", "Verify an existing passkey before adding another", method.verifyAdd, Assertion),
    post("finishAddPasskey", "/passkeys/add/finish", "Save the verified new passkey", method.finishAdd, Registration),
    post("renamePasskey", "/passkeys/:passkeyId", "Rename a passkey", (call, input, context) => method.rename(call, context.params.passkeyId ?? "", input.name), Rename, "PATCH"),
    post("startRemovePasskey", "/passkeys/:passkeyId/remove/start", "Confirm removal with another passkey", (call, _, context) => method.startRemove(call, context.params.passkeyId ?? ""), Schema.Undefined),
    post("finishRemovePasskey", "/passkeys/:passkeyId/remove/finish", "Remove a passkey after confirmation", (call, input, context) => method.finishRemove(call, { ...input, passkeyId: context.params.passkeyId ?? "" }), Assertion),
    {
      id: "auth.passkeys.settings.get", method: "GET", path: "/passkeys/settings", access: settingsAccess,
      spec: { operationId: "getPasskeySettings", summary: "Read passkey settings", tags: ["auth"], responses: { 200: { description: "Relying-party settings" } } },
      handler: () => respond(Effect.map(settings.get(), ok)),
    },
    {
      id: "auth.passkeys.settings.set", method: "PUT", path: "/passkeys/settings", access: settingsAccess,
      maxRequestBodyBytes: BODY_LIMIT, invalidJsonBodyCode: "invalid_request",
      spec: {
        operationId: "setPasskeySettings", summary: "Set passkey settings", tags: ["auth"],
        requestBody: { required: true, schema: Schema.toJsonSchemaDocument(PasskeySettingsInput).schema },
        responses: { 200: { description: "Saved relying-party settings" }, 400: { description: "Invalid relying-party settings" } },
      },
      handler: (context) => respond(Effect.gen(function* () {
        const input = Schema.decodeUnknownOption(PasskeySettingsInput)(context.body);
        if (input._tag === "None") return invalidSettings();
        const saved = yield* settings.set(input.value);
        return saved === null ? invalidSettings() : ok(saved);
      })),
    },
  ];
}
