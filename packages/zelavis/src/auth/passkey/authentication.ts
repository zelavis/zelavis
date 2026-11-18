// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/authentication.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Effect from "effect/Effect";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { integration } from "../../core/runtime/effect-boundary.js";
import { fromBase64URL } from "../methods/username-passkey/base64url.js";
import { isSameOriginCeremony } from "./helpers.js";
import type { RelyingParty } from "./registration.js";
import type { ChallengeRow, PasskeyRow } from "./tables.js";
import type { WireAuthenticationResponse } from "./validation.js";

/** Verify the signed assertion against the credential read before hashing or signature work. */
export const verifyAssertion = Effect.fn("auth.passkey.verifyAssertion")(function* (
  settings: RelyingParty,
  challenge: ChallengeRow,
  passkey: PasskeyRow,
  response: WireAuthenticationResponse,
) {
  if (!(yield* isSameOriginCeremony(response.response.clientDataJSON))) return null;
  const verification = yield* Effect.option(integration(() => verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: [...settings.origins],
    expectedRPID: settings.rpId,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(fromBase64URL(passkey.publicKey)),
      // As upstream, synced credentials may report zero or non-monotonic counters.
      // The single-use challenge is the replay check.
      counter: 0,
    },
    requireUserVerification: true,
  })));
  return verification._tag === "Some" && verification.value.verified
    ? verification.value.authenticationInfo.newCounter : null;
});
