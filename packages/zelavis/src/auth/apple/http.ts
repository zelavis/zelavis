// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/apple/http.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the callback is not an httpRouter of its own but the provider part of the shared callback route: its exchange configuration is built from the connection's credentials (T1).
/**
 * Apple's callback.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { ClaimedRequest } from "../lib/oauth/callback.js";
import type { CallbackProvider } from "../lib/oauth/http.js";
import { CALLBACK_METHOD, ISSUER, PROVIDER_NAME, TOKEN_ENDPOINT, USER_CANCELLED_ERROR } from "./constants.js";
import { mintClientSecret } from "./secret.js";
import { sanitizeAppleUser } from "./user.js";

/** `clientId` is the Services ID; `privateKey` is the `.p8` key, which is the connection's client secret. */
export const appleCallback = (
  credentials: { clientId: string; privateKey: string; teamId: string; keyId: string },
  clock: () => number,
): CallbackProvider<ClaimedRequest> => ({
  methods: [CALLBACK_METHOD],
  exchangeConfig: () =>
    Effect.succeed({
      providerName: PROVIDER_NAME,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: credentials.clientId,
      // Apple has no static secret, so one is signed per exchange.
      clientSecret: () =>
        mintClientSecret({
          privateKey: credentials.privateKey,
          teamId: credentials.teamId,
          keyId: credentials.keyId,
          clientId: credentials.clientId,
          now: clock(),
        }),
      issuers: [ISSUER],
    }),
  // The name is browser-relayed, so it is sanitized before it can reach the
  // ticket payload. Apple sends it on a first authorization only.
  sanitizeParams: (fields) => {
    const user = sanitizeAppleUser(fields.get("user"));
    return user === undefined ? undefined : { user };
  },
  extraDeniedErrorCodes: [USER_CANCELLED_ERROR],
});
