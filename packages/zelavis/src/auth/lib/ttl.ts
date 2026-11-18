// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/ttl.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: validators become Effect Schemas, the access-token default is 300 seconds, and the access-token ceiling is exported.
import * as Schema from "effect/Schema";

// Defaults for the configurable lifetimes. The runtime overrides them through
// `createAuth`, which resolves the full configuration once and passes it to
// the core on every call.
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 300; // 5 minutes (upstream: 60)
export const DEFAULT_SESSION_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60; // 30 days

// The signing key refuses to mint a token that lives longer than an hour, so
// an access-token TTL past that is a misconfiguration.
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * The configuration for token and session lifetimes.
 *
 * A session expires at the sooner of two deadlines:
 *
 *  - `refreshInactivityTimeoutSeconds` after its newest issued refresh token
 *    was issued, i.e. after its last refresh. Each refresh pushes it later.
 *  - `sessionMaxLifetimeSeconds` after the session was created, however often
 *    it refreshes.
 */
export type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshInactivityTimeoutSeconds: number;
  sessionMaxLifetimeSeconds: number;
};

/** The fields of a `TtlConfig`, for the core functions' arguments. */
export const TtlConfigFields = {
  accessTokenTtlSeconds: Schema.Number,
  refreshInactivityTimeoutSeconds: Schema.Number,
  sessionMaxLifetimeSeconds: Schema.Number,
};

/**
 * Produces a valid `TtlConfig` from the runtime's options, filling in the
 * defaults for the values it leaves out. The refresh inactivity timeout
 * defaults to the max lifetime, whether that is the default or the runtime's.
 * A session's newest token is never older than the session, so at that default
 * only the max lifetime ends a session.
 *
 * Throws when given invalid values.
 */
export function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshInactivityTimeoutSeconds?: number;
  sessionMaxLifetimeSeconds?: number;
}): TtlConfig {
  const sessionMaxLifetimeSeconds =
    args.sessionMaxLifetimeSeconds ?? DEFAULT_SESSION_MAX_LIFETIME_SECONDS;
  return validateTtlConfig({
    accessTokenTtlSeconds:
      args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    refreshInactivityTimeoutSeconds:
      args.refreshInactivityTimeoutSeconds ?? sessionMaxLifetimeSeconds,
    sessionMaxLifetimeSeconds,
  });
}

/**
 * Checks a complete `TtlConfig` and returns it.
 *
 * Throws when given invalid values.
 */
export function validateTtlConfig(ttl: TtlConfig): TtlConfig {
  const {
    accessTokenTtlSeconds,
    refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds,
  } = ttl;
  // Every comparison with `NaN` is false, so check finiteness first.
  if (
    !Number.isFinite(accessTokenTtlSeconds) ||
    !Number.isFinite(refreshInactivityTimeoutSeconds) ||
    !Number.isFinite(sessionMaxLifetimeSeconds)
  ) {
    throw new Error("Token and session lifetimes must be finite numbers.");
  }
  if (
    accessTokenTtlSeconds <= 0 ||
    refreshInactivityTimeoutSeconds <= 0 ||
    sessionMaxLifetimeSeconds <= 0
  ) {
    throw new Error("Token and session lifetimes must be positive.");
  }
  if (accessTokenTtlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(
      "Access-token TTL must be at most one hour (the signing key refuses " +
        "to sign a longer-lived JWT).",
    );
  }
  if (accessTokenTtlSeconds >= refreshInactivityTimeoutSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh inactivity timeout.",
    );
  }
  // With the check above, this keeps the access-token TTL shorter than the
  // max lifetime too.
  if (refreshInactivityTimeoutSeconds > sessionMaxLifetimeSeconds) {
    throw new Error(
      "Refresh inactivity timeout must be at most the session max lifetime.",
    );
  }
  return {
    accessTokenTtlSeconds,
    refreshInactivityTimeoutSeconds,
    sessionMaxLifetimeSeconds,
  };
}
