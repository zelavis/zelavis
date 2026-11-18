// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/crypto.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the WebCrypto calls are Effects (T1); a token that cannot be read fails with OAuthProviderFailure instead of throwing; the ticket payload key prefix names Zelavis.
/**
 * The crypto every OAuth provider and its redemption share.
 *
 * Starting a flow uses these to mint the PKCE verifier and its challenge and
 * redemption to decrypt a ticket payload. The callback uses them to decode an
 * id_token and to encrypt a ticket payload.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { integration } from "../../../core/runtime/effect-boundary.js";
import { generateRandomToken } from "../crypto.js";

export { generateRandomToken };

/** The provider could not be reached or answered something this flow cannot use. `unavailable` marks a transport or HTTP failure (the user may retry later) as against a token the provider delivered that fails validation. */
export class OAuthProviderFailure extends Schema.TaggedError<OAuthProviderFailure>()("OAuthProviderFailure", {
  message: Schema.String,
  unavailable: Schema.Boolean,
}) {}

export const providerFailure = (message: string, unavailable = false) => new OAuthProviderFailure({ message, unavailable });

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url(SHA-256(value)) — the PKCE `S256` code challenge encoding. */
export const sha256Base64Url = Effect.fn("auth.lib.oauth.sha256Base64Url")(function* (value: string) {
  const digest = yield* integration(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(Effect.orDie);
  return base64UrlEncode(new Uint8Array(digest));
});

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

declare const issuerDelivered: unique symbol;

/**
 * A JWT received directly from the issuer over TLS. Cast to this type only at
 * the fetch that received it; transport is what stands in for a signature
 * check (or the signature was verified against the issuer's key set).
 */
export type IssuerDeliveredJwt = string & { [issuerDelivered]: true };

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeJsonObject = Schema.decodeUnknownExit(Schema.fromJsonString(JsonObject));

/**
 * Decode a JWT's payload without verifying its signature. Only safe for
 * tokens received directly from the issuer over TLS (e.g. an id_token from
 * the token exchange), where transport authenticates the issuer; the branded
 * argument type is what holds callers to that.
 */
export const decodeJwtPayloadUnverified = Effect.fn("auth.lib.oauth.decodeJwtPayloadUnverified")(function* (jwt: IssuerDeliveredJwt) {
  const parts = jwt.split(".");
  const encoded = parts[1];
  if (parts.length !== 3 || encoded === undefined) return yield* providerFailure("Malformed JWT");
  const text = yield* Effect.try({ try: () => new TextDecoder().decode(base64UrlDecode(encoded)), catch: () => providerFailure("Malformed JWT") });
  const payload = decodeJsonObject(text);
  if (!Exit.isSuccess(payload)) return yield* providerFailure("Malformed JWT");
  return payload.value;
});

/**
 * AES-256-GCM key for a ticket payload. The key is only as strong as the
 * ticket code, which is 256 bits of randomness.
 */
const deriveTicketPayloadKey = Effect.fn("auth.lib.oauth.deriveTicketPayloadKey")(function* (ticketCode: string) {
  // The prefix matters: the ticket stores SHA-256(code) as its lookup
  // hash, so hashing the bare code here would make the stored hash the key.
  const keyBytes = yield* integration(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(`zelavis-auth-ticket-payload:${ticketCode}`))).pipe(Effect.orDie);
  return yield* integration(() => crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"])).pipe(Effect.orDie);
});

/**
 * Encrypt a ticket payload with a key derived from the raw ticket code.
 *
 * A ticket is the short-lived, one-time record the callback mints after a
 * successful code exchange (the `tickets` table in schema.ts); its payload
 * is the provider-attested identity JSON (`{ claims, userInfoResponses }`)
 * that redemption decrypts. Only the code's hash is persisted, and the raw
 * code (the only value the key can be derived from) travels solely in the
 * callback redirect URL, so database access alone cannot decrypt the
 * result. Returns the random nonce followed by the ciphertext,
 * base64url-encoded.
 */
export const encryptTicketPayload = Effect.fn("auth.lib.oauth.encryptTicketPayload")(function* (ticketCode: string, plaintext: string) {
  const key = yield* deriveTicketPayloadKey(ticketCode);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    yield* integration(() => crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))).pipe(Effect.orDie),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return base64UrlEncode(combined);
});

/**
 * Decrypt {@link encryptTicketPayload} output. Fails when the ticket code
 * is wrong or the payload was tampered with (AES-GCM authenticates).
 */
export const decryptTicketPayload = Effect.fn("auth.lib.oauth.decryptTicketPayload")(function* (ticketCode: string, encrypted: string) {
  const key = yield* deriveTicketPayloadKey(ticketCode);
  const combined = base64UrlDecode(encrypted);
  const plaintext = yield* integration(() => crypto.subtle.decrypt({ name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12))).pipe(
    Effect.mapError(() => providerFailure("The ticket payload cannot be decrypted")),
  );
  return new TextDecoder().decode(plaintext);
});
