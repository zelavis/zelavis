// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/oauthParams.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the outcome travels in the URL fragment (`#ticket=`, `#error=`) of the redirect, never in its query, and is named without the `convexAuth` prefix.
/**
 * Fragment parameter names used by the OAuth callback, appended to the
 * redirect back to the browser.
 *
 * Shared by the callback (which writes them) and the clients (which read
 * them) so the two ends can never drift. They travel in the fragment: a
 * fragment is never sent to a server, so a ticket code cannot reach a proxy
 * log or a `Referer` header.
 *
 * @module
 */

/** Carries the one-time code the client redeems for a session. */
export const OAUTH_CODE_PARAM = "ticket";

/**
 * Carries why the flow failed: `access_denied`, `expired`, `oauth_error` or
 * `provider_unavailable`.
 */
export const OAUTH_ERROR_PARAM = "error";
