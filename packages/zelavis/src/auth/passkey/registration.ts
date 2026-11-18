// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/registration.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Effect from "effect/Effect";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { integration } from "../../core/runtime/effect-boundary.js";
import { defaultPasskeyName } from "../methods/username-passkey/aaguids.js";
import { toBase64URL } from "../methods/username-passkey/base64url.js";
import { SUPPORTED_ALGORITHM_IDS } from "./constants.js";
import { isSameOriginCeremony } from "./helpers.js";
import type { ChallengeRow } from "./tables.js";
import type { WireRegistrationResponse } from "./validation.js";

export interface RelyingParty {
  readonly rpId: string;
  readonly rpName: string;
  readonly origins: ReadonlyArray<string>;
  readonly revision: string;
}

/** Verify attestation outside the transaction that consumes its challenge. */
export const verifyAttestation = Effect.fn("auth.passkey.verifyAttestation")(function* (
  settings: RelyingParty,
  challenge: ChallengeRow,
  response: WireRegistrationResponse,
) {
  if (!(yield* isSameOriginCeremony(response.response.clientDataJSON))) return null;
  const verification = yield* Effect.option(integration(() => verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: [...settings.origins],
    expectedRPID: settings.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
  })));
  if (verification._tag === "None" || !verification.value.verified) return null;
  const { credential } = verification.value.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: toBase64URL(Uint8Array.from(credential.publicKey).buffer),
    counter: credential.counter,
    transports: credential.transports,
    name: defaultPasskeyName(response),
  };
});
