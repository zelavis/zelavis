// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/username-passkey/client.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: run the browser ceremony and the start/finish HTTP calls in Effect.
import {
  browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, startRegistration, WebAuthnAbortService,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type { AuthBrowserCall } from "./auth-oauth.js";

const Descriptor = Schema.Struct({
  type: Schema.Literal("public-key"), id: Schema.String,
  transports: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
});
const Descriptors = Schema.mutable(Schema.Array(Descriptor).check(Schema.isMaxLength(256)));
const CreationOptions = Schema.Struct({
  rp: Schema.Struct({ id: Schema.String, name: Schema.String }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }),
  challenge: Schema.String, timeout: Schema.Number,
  excludeCredentials: Schema.optional(Descriptors),
  pubKeyCredParams: Schema.mutable(Schema.Array(Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Number }))),
  authenticatorSelection: Schema.Struct({
    residentKey: Schema.Literal("required"), requireResidentKey: Schema.Literal(true), userVerification: Schema.Literal("required"),
  }),
  attestation: Schema.Literal("none"),
});
const RequestOptions = Schema.Struct({
  challenge: Schema.String, timeout: Schema.Number, rpId: Schema.String, allowCredentials: Descriptors,
  userVerification: Schema.Literal("required"),
});
const FlowId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const RegistrationStart = Schema.Struct({ flowId: FlowId, options: CreationOptions });
const AuthenticationStart = Schema.Struct({ flowId: FlowId, options: RequestOptions });

class BrowserPasskeyError extends Data.TaggedError("BrowserPasskeyError")<{ message: string; cause?: unknown }> {}
const invalidOptions = () => new BrowserPasskeyError({ message: "The server returned invalid passkey options." });
const unsupported = () => new BrowserPasskeyError({ message: "This browser cannot use passkeys." });
const ceremonyError = (cause: unknown): BrowserPasskeyError => {
  if (cause instanceof Error && (cause.name === "NotAllowedError" || cause.name === "AbortError")) {
    return new BrowserPasskeyError({ message: "The passkey prompt was cancelled.", cause });
  }
  if (cause instanceof Error && cause.name === "InvalidStateError") {
    return new BrowserPasskeyError({ message: "This device already holds a passkey for the account.", cause });
  }
  return new BrowserPasskeyError({ message: "The passkey prompt could not complete.", cause });
};

export const passkeysSupported = browserSupportsWebAuthn;
export const passkeyAutofillAvailable = Effect.tryPromise({
  try: browserSupportsWebAuthnAutofill,
  catch: ceremonyError,
});

const cancelCeremony = Effect.sync(() => WebAuthnAbortService.cancelCeremony());

function registrationProof(start: unknown) {
  return Effect.gen(function* () {
    if (!passkeysSupported()) return yield* Effect.fail(unsupported());
    const decoded = Schema.decodeUnknownOption(RegistrationStart)(start);
    if (decoded._tag === "None") return yield* Effect.fail(invalidOptions());
    const { flowId, options } = decoded.value;
    // The validated wire options permit future transport names. The browser library forwards them to WebAuthn.
    const response = yield* Effect.tryPromise({ try: () => startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON }), catch: ceremonyError })
      .pipe(Effect.onInterrupt(() => cancelCeremony));
    const { id, rawId, type, response: { clientDataJSON, attestationObject, transports } } = response;
    return { flowId, response: { id, rawId, type, response: { clientDataJSON, attestationObject, transports }, clientExtensionResults: {} } };
  });
}

function authenticationProof(start: unknown, useBrowserAutofill = false) {
  return Effect.gen(function* () {
    if (!passkeysSupported()) return yield* Effect.fail(unsupported());
    const decoded = Schema.decodeUnknownOption(AuthenticationStart)(start);
    if (decoded._tag === "None") return yield* Effect.fail(invalidOptions());
    const { flowId, options } = decoded.value;
    const response = yield* Effect.tryPromise({
      try: () => startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON, useBrowserAutofill }),
      catch: ceremonyError,
    }).pipe(Effect.onInterrupt(() => cancelCeremony));
    const { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle } } = response;
    return { flowId, response: { id, rawId, type, response: { clientDataJSON, authenticatorData, signature, userHandle }, clientExtensionResults: {} } };
  });
}

export function registerBrowserPasskey<E>(call: AuthBrowserCall<E>, username: string) {
  return Effect.gen(function* () {
    if (!passkeysSupported()) return yield* Effect.fail(unsupported());
    const start = yield* call("username-passkey/sign-up/start", { username });
    return yield* call("username-passkey/sign-up/finish", yield* registrationProof(start));
  });
}

export function authenticateBrowserPasskey<E>(call: AuthBrowserCall<E>, username?: string) {
  return Effect.gen(function* () {
    if (!passkeysSupported()) return yield* Effect.fail(unsupported());
    const start = yield* (username === undefined
      ? call("username-passkey/sign-in/autofill", {})
      : call("username-passkey/sign-in/start", { username }));
    return yield* call("username-passkey/sign-in/finish", yield* authenticationProof(start, username === undefined));
  });
}

/** Confirm the session with an existing passkey, then register a new one. */
export function addBrowserPasskey<E>(call: AuthBrowserCall<E>) {
  return Effect.gen(function* () {
    const challenge = yield* call("passkeys/add/start");
    const registration = yield* call("passkeys/add/verify", yield* authenticationProof(challenge));
    return yield* call("passkeys/add/finish", yield* registrationProof(registration));
  });
}

/** Confirm removal using a different passkey. The server selects eligible credentials. */
export function removeBrowserPasskey<E>(call: AuthBrowserCall<E>, passkeyId: string) {
  const path = `passkeys/${encodeURIComponent(passkeyId)}/remove`;
  return Effect.gen(function* () {
    const challenge = yield* call(`${path}/start`);
    return yield* call(`${path}/finish`, yield* authenticationProof(challenge));
  });
}
