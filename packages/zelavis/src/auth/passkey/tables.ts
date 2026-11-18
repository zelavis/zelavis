// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/passkey/schema.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Adapted to the Zelavis Auth runtime and Effect transaction boundaries.
import * as Schema from "effect/Schema";
import { ADD_PASSKEY_PURPOSE, REMOVE_PASSKEY_PURPOSE, SIGN_IN_PURPOSE } from "../methods/username-passkey/purposes.js";
import type { RowOf } from "../core/tables.js";
import { defineTable, defineTables } from "../runtime/index.js";

const optionalString = Schema.optional(Schema.String);

export const passkeyTables = defineTables("passkey", {
  passkeys: defineTable({
    userId: Schema.String,
    rpId: Schema.String,
    credentialId: Schema.String,
    publicKey: Schema.String,
    counter: Schema.Number,
    transports: Schema.optional(Schema.Array(Schema.String)),
    name: optionalString,
  }).index("by_rp_credential", ["rpId", "credentialId"]).index("by_user_rp", ["userId", "rpId"]),
  handles: defineTable({
    handle: Schema.String,
    userId: Schema.String,
    rpId: Schema.String,
  }).index("by_user_rp", ["userId", "rpId"]).index("by_rp_handle", ["rpId", "handle"]),
  challenges: defineTable({
    challenge: Schema.String,
    expiresAt: Schema.Number,
    revision: Schema.String,
    purpose: Schema.Literals(["register", "add-register", SIGN_IN_PURPOSE, ADD_PASSKEY_PURPOSE, REMOVE_PASSKEY_PURPOSE]),
    username: optionalString,
    userId: optionalString,
    sessionId: optionalString,
    handle: optionalString,
    removeId: optionalString,
    verifiedPasskeyId: optionalString,
  }).index("by_expiresAt", ["expiresAt"]),
  settings: defineTable({
    rpId: Schema.String,
    rpName: Schema.String,
    origins: Schema.Array(Schema.String),
    revision: Schema.String,
  }),
});

export type PasskeyRow = RowOf<typeof passkeyTables.passkeys>;
export type ChallengeRow = RowOf<typeof passkeyTables.challenges>;
