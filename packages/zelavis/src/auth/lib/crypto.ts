// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/crypto.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: sha256Hex is an Effect (T1), the async digest running through the integration boundary.
/**
 * Crypto helpers shared across the core and the optional modules.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import { integration } from "../../core/runtime/effect-boundary.js";

/**
 * SHA-256 hex digest. Used wherever a secret (refresh token, OAuth state,
 * ticket code) must be looked up later without persisting the raw value. A
 * digest of in-memory bytes cannot fail; if it does, that is a defect.
 */
export const sha256Hex = Effect.fn("auth.lib.sha256Hex")(function* (value: string) {
  const digest = yield* integration(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  ).pipe(Effect.orDie);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
});

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Cryptographically random 256-bit opaque token, base64url encoded. Used for
 * the tokens that a challenge or a ticket hands out and later hashes.
 */
export function generateRandomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
