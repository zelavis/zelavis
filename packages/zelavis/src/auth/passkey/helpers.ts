// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/helpers.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Effect from "effect/Effect";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";

import type { AuthTxBase } from "../runtime/index.js";
import { generateRandomToken } from "../lib/crypto.js";
import { fromBase64URL } from "../methods/username-passkey/base64url.js";
import { CHALLENGE_TTL_MS } from "./constants.js";
import { passkeyTables, type ChallengeRow, type PasskeyRow } from "./tables.js";

export const MAX_PASSKEYS_PER_USER = 20;

/** Upstream accepts ceremonies on the relying party's own page. */
export const isSameOriginCeremony = (encoded: string) => Effect.try(() => {
  const data = decodeClientDataJSON(encoded);
  return !data.crossOrigin && data.topOrigin === undefined;
}).pipe(Effect.orElseSucceed(() => false));

export const passkeysForUser = (tx: AuthTxBase, userId: string, rpId: string) =>
  tx.db.query(passkeyTables.passkeys).withIndex("by_user_rp", (q) => q.eq("userId", userId).eq("rpId", rpId)).take(MAX_PASSKEYS_PER_USER + 1);

export const passkeyByCredential = (tx: AuthTxBase, rpId: string, credentialId: string) =>
  tx.db.query(passkeyTables.passkeys).withIndex("by_rp_credential", (q) => q.eq("rpId", rpId).eq("credentialId", credentialId)).unique();

export const handleForUser = (tx: AuthTxBase, userId: string, rpId: string) =>
  tx.db.query(passkeyTables.handles).withIndex("by_user_rp", (q) => q.eq("userId", userId).eq("rpId", rpId)).unique();

export const credentialDescriptors = (rows: ReadonlyArray<PasskeyRow>) => rows.map((row) => ({
  id: fromBase64URL(row.credentialId),
  ...(row.transports === undefined ? {} : { transports: [...row.transports] }),
}));

/** A challenge is written before the browser receives the corresponding options. */
export const insertChallenge = (tx: AuthTxBase, fields: Omit<ChallengeRow, "_id" | "_creationTime" | "expiresAt" | "challenge">) => {
  const challenge = generateRandomToken();
  return tx.db.insert(passkeyTables.challenges, { ...fields, challenge, expiresAt: tx.now + CHALLENGE_TTL_MS }).pipe(
    Effect.map((flowId) => ({ flowId, challenge: fromBase64URL(challenge) })),
  );
};
