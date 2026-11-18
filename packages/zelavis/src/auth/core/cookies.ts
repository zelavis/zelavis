// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/ssr/cookies.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the cookie store is synchronous and collects Set-Cookie headers for a response, cookie names and paths follow the runtime (D7), the access token's cookie path is the API base and the refresh token's is its session route, and the Next.js-oriented options are not carried.
/**
 * Auth cookies for browsers on Zelavis origins (the dashboard and App sites).
 *
 * The access token travels in an HttpOnly cookie scoped to the API base or dashboard mount, and
 * the refresh token in an HttpOnly cookie scoped to the session routes, so the
 * refresh token is sent only where it is spent and never reaches client JS.
 * Both live as long as the refresh token: the access token expires sooner, and
 * a request that arrives with an expired one is answered `access_token_expired`
 * so the page refreshes (`POST /auth/session/refresh`).
 *
 * Nothing here depends on a framework.
 *
 * @module
 */
import type { TokenBundle } from "../lib/types.js";

/** Attributes applied when writing a cookie. The low-level shape, all optional. */
export interface CookieOptions {
  /** Whether to hide the cookie from client JS. */
  httpOnly?: boolean;
  /** Whether to send only over HTTPS. */
  secure?: boolean;
  /** CSRF posture. Defaults to `"lax"`. */
  sameSite?: "lax" | "strict" | "none";
  /** Cookie path. Defaults to `"/"`. */
  path?: string;
  /** Max age in seconds. */
  maxAge?: number;
}

/**
 * The attributes that identify which cookie a deletion targets: browsers only
 * remove a cookie when the deletion's `path` matches the one it was written
 * with.
 */
export type CookieDeleteOptions = Pick<CookieOptions, "path" | "secure">;

/** Write and delete cookies. */
export interface CookieStore {
  /** Write a cookie. */
  set: (name: string, value: string, options?: CookieOptions) => void;
  /** Delete a cookie. Must be given the same `path` the cookie was written with, or the deletion won't match it. */
  delete: (name: string, options?: CookieDeleteOptions) => void;
}

/**
 * How a runtime's auth cookies are named and scoped.
 *
 * `secure` is required. Whether auth cookies are HTTPS-only depends on the
 * deployment (HTTPS in production, plain http on localhost), so every route
 * decides it explicitly (from the request's protocol) rather than inherit a
 * default that would be wrong in one environment or the other.
 */
export interface AuthCookieConfig {
  readonly accessName: string;
  readonly refreshName: string;
  /** The path the API is served under, without a trailing slash; empty for the root. */
  readonly apiBase: string;
  /** The Platform dashboard mount also carries the access cookie for server views. */
  readonly accessPath?: string;
  readonly secure: boolean;
}

/** The cookie names of the Platform's Auth. */
export const PLATFORM_ACCESS_COOKIE = "zelavis_access";
export const PLATFORM_REFRESH_COOKIE = "zelavis_refresh";

/** The cookie names of a Project's Auth, from the Project's session audience (24 hex characters). */
export const projectAuthCookieNames = (audience: string) => ({
  accessName: `zelavis_app_${audience}`,
  refreshName: `zelavis_app_${audience}_refresh`,
});

/** The path the refresh token is sent on: the session routes. */
export const refreshCookiePath = (apiBase: string) => `${apiBase}/auth/session`;
/** The path the access token is sent on: the whole API. */
export const accessCookiePath = (apiBase: string) => (apiBase === "" ? "/" : apiBase);

/**
 * The environment-independent attributes for auth cookies, merged under the
 * per-cookie ones.
 *
 *  * `httpOnly: true` (so neither token reaches client JS)
 *  * `sameSite: "lax"` to aid in CSRF protection (see
 *     https://auth.pilcrowonpaper.com/csrf)
 */
function invariantCookieOptions(): Omit<CookieOptions, "secure" | "path"> {
  return {
    httpOnly: true,
    sameSite: "lax",
  };
}

/**
 * The attributes an auth cookie is written with: the invariant ones, the
 * cookie's path, and a lifetime taken from the refresh token's expiry. Both
 * cookies live that long; the access token expires sooner and gets refreshed.
 */
function authCookieOptions(
  path: string,
  refreshTokenExpiresAt: number,
  now: number,
  config: AuthCookieConfig,
): CookieOptions {
  return {
    ...invariantCookieOptions(),
    path,
    secure: config.secure,
    maxAge: Math.max(0, Math.floor((refreshTokenExpiresAt - now) / 1000)),
  };
}

/**
 * Write the tokens in a `bundle` as cookies.
 *
 * The access token is stored in the access cookie and the refresh token in the
 * refresh cookie. The invariant attributes (httpOnly etc.) are merged in.
 *
 * This is the one place that knows which cookies hold a session, so refresh
 * and every method's sign-in route write cookies identically.
 */
export function writeAuthCookies(
  cookies: CookieStore,
  bundle: TokenBundle,
  config: AuthCookieConfig,
  now: number,
): void {
  cookies.set(config.accessName, bundle.accessToken, authCookieOptions((config.accessPath ?? accessCookiePath(config.apiBase)), bundle.refreshTokenExpiresAt, now, config));
  cookies.set(config.refreshName, bundle.refreshToken, authCookieOptions(refreshCookiePath(config.apiBase), bundle.refreshTokenExpiresAt, now, config));
}

/**
 * Delete both auth cookies. The counterpart of {@link writeAuthCookies}: it
 * takes the same config so the deletions match the cookies the writes
 * produced (a deletion only removes a cookie whose `path` matches).
 */
export function clearAuthCookies(cookies: CookieStore, config: AuthCookieConfig): void {
  cookies.delete(config.accessName, { path: (config.accessPath ?? accessCookiePath(config.apiBase)), secure: config.secure });
  cookies.delete(config.refreshName, { path: refreshCookiePath(config.apiBase), secure: config.secure });
}

/** One `Set-Cookie` value. Token values are base64url and JWT characters, so they need no encoding. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`];
  if (options.httpOnly) parts.push("HttpOnly");
  const sameSite = options.sameSite ?? "lax";
  parts.push(`SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`);
  if (options.secure) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

/** A store that collects the `Set-Cookie` headers of one response. */
export function responseCookies(): { readonly store: CookieStore; readonly headers: () => Array<[string, string]> } {
  const lines: string[] = [];
  return {
    store: {
      set: (name, value, options) => { lines.push(serializeCookie(name, value, options)); },
      delete: (name, options) => { lines.push(serializeCookie(name, "", { ...options, httpOnly: true, maxAge: 0 })); },
    },
    headers: () => lines.map((line): [string, string] => ["set-cookie", line]),
  };
}

/** One cookie of a request, or undefined. A malformed value is ambient noise, not an error: it reads as absent. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}
