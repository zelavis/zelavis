// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/validation.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Schema from "effect/Schema";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

export type CredentialDescriptor = { id: ArrayBuffer; transports?: string[] };
export type WireCreationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout: number;
  excludeCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }> | undefined;
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "required" };
  attestation: "none";
  extensions: Record<string, never>;
};
export type WireRequestOptions = {
  challenge: string;
  timeout: number;
  rpId: string;
  allowCredentials: Array<{ type: "public-key"; id: string; transports?: string[] }>;
  userVerification: "required";
};
export type WireRegistrationResponse = RegistrationResponseJSON;
export type WireAuthenticationResponse = AuthenticationResponseJSON;

const Base64Url = Schema.String.check(Schema.isPattern(/^(?=.+$)(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/u));
const Transport = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,32}$/u));
const Envelope = {
  id: Base64Url,
  rawId: Base64Url,
  type: Schema.Literal("public-key"),
  authenticatorAttachment: Schema.optional(Schema.Literals(["platform", "cross-platform"])),
  clientExtensionResults: Schema.Struct({}),
};

// Copy lists at the boundary because SimpleWebAuthn accepts mutable transport arrays.
export const RegistrationResponse = Schema.Struct({
  ...Envelope,
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    attestationObject: Base64Url,
    transports: Schema.optional(Schema.mutable(Schema.Array(Transport).check(Schema.isMaxLength(16)))),
  }),
});
export const AuthenticationResponse = Schema.Struct({
  ...Envelope,
  response: Schema.Struct({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Schema.optional(Base64Url),
  }),
});

/**
 * The largest length of a passkey name, in Unicode code points. A name is a
 * short label in a settings list ("MacBook Touch ID"); the limit stops a
 * client from writing large data to the row.
 */
export const MAX_PASSKEY_NAME_LENGTH = 50;

/**
 * Characters that make the text direction or the position of the subsequent
 * characters different, and characters that show nothing. An attacker uses
 * them to show a name that is not the name that the component stores, or to
 * make a name disappear from the settings list. The list is the list of the
 * username validator.
 *
 * The list does not contain the zero-width joiner (U+200D) and the
 * zero-width non-joiner (U+200C). These two characters are necessary to
 * write some scripts correctly, and also to write emoji sequences.
 */
const BIDI_AND_INVISIBLE_CONTROLS =
  /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

/**
 * Examine a passkey name before the component stores it.
 *
 * The component only refuses what no real label is: an empty or
 * whitespace-only string, control characters, characters that spoof how the
 * name shows, or a length over {@link MAX_PASSKEY_NAME_LENGTH} code points.
 */
export function passkeyNameIsValid(name: string): boolean {
  return (
    name.trim().length > 0 &&
    [...name].length <= MAX_PASSKEY_NAME_LENGTH &&
    // `\p{Cc}` is the whole Unicode control category: the C0 range and
    // DEL, and the C1 range (U+0080-U+009F), which a paste from a legacy
    // encoding can carry.
    !/\p{Cc}/u.test(name) &&
    !BIDI_AND_INVISIBLE_CONTROLS.test(name)
  );
}
