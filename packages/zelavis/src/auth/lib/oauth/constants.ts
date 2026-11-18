// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauth/constants.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the callback is a route of the runtime's API, `<api>/auth/oauth/<provider>/callback`, not a component's `httpPrefix` plus `/callback`.
/**
 * OAuth callback path, used in multiple places.
 *
 * Every provider serves its callback under the runtime's own API, at
 * `<api>/auth/oauth/<provider>/callback`. The operator registers the full URL
 * with the provider and stores it as the connection's `redirectUri`.
 *
 * @module
 */

/** The route prefix of every OAuth route, under the API base. */
export const OAUTH_ROUTE_PREFIX = "/auth/oauth";

/** The path (below the API base) a provider's callback is served at. */
export const callbackPath = (provider: string): string => `${OAUTH_ROUTE_PREFIX}/${provider}/callback`;
