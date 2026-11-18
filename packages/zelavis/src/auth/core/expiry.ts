// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/component/expiry.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the row type is the Auth runtime's AuthRow instead of a Convex Doc.
// When refresh tokens and sessions expire under the configured lifetimes.

import type { AuthRow } from "../runtime/index.js";

/**
 * Returns a timestamp for when a refresh token stops being able to refresh its
 * session for lack of use, under the given inactivity timeout.
 *
 * Expiry is derived rather than stored, so a changed timeout applies to every
 * outstanding token.
 */
export function refreshTokenInactivityExpiresAt(
  token: Pick<AuthRow, "_creationTime">,
  refreshInactivityTimeoutSeconds: number,
): number {
  return token._creationTime + refreshInactivityTimeoutSeconds * 1000;
}

/**
 * Returns a timestamp for when a session reaches its max lifetime.
 *
 * Derived from the session's `_creationTime`, so a changed max lifetime
 * applies to every session.
 */
export function sessionMaxLifetimeExpiresAt(
  session: Pick<AuthRow, "_creationTime">,
  sessionMaxLifetimeSeconds: number,
): number {
  return session._creationTime + sessionMaxLifetimeSeconds * 1000;
}
