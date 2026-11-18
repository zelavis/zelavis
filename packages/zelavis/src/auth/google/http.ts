// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/components/google/http.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the callback is not an httpRouter of its own but the provider part of the shared callback route: its exchange configuration is built from the connection's credentials (T1).
/**
 * Google's callback.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import type { ClaimedRequest } from "../lib/oauth/callback.js";
import type { CallbackProvider } from "../lib/oauth/http.js";
import { ISSUERS, PROVIDER_NAME, TOKEN_ENDPOINT } from "./constants.js";

export const googleCallback = (credentials: { clientId: string; clientSecret: string }): CallbackProvider<ClaimedRequest> => ({
  exchangeConfig: () =>
    Effect.succeed({
      providerName: PROVIDER_NAME,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: credentials.clientId,
      clientSecret: () => Effect.succeed(credentials.clientSecret),
      issuers: ISSUERS,
    }),
});
