/**
 * Helpers for reconciling browser paths with the router basename.
 *
 * The dashboard can be mounted under a base path (`/zelavis` by default).
 * Browser pathnames include that basename; `navigate()` prepends it. Mixing
 * the two produces nested paths such as `/zelavis/zelavis/`.
 */

/** The configured basename, normalized without a trailing slash ("" when unmounted). */
export function routerBasename(): string {
  return import.meta.env.BASE_URL.replace(/\/+$/, "");
}

/**
 * Makes a browser pathname router-relative.
 *
 * Strips *every* leading repetition of the basename, not just one, so a path
 * that already accumulated nesting collapses back to a usable route instead of
 * growing further on the next navigation.
 */
export function stripRouterBasename(pathname: string): string {
  const basename = routerBasename();
  if (!basename) {
    return pathname || "/";
  }

  let path = pathname;
  while (path === basename || path.startsWith(`${basename}/`)) {
    path = path.slice(basename.length);
  }

  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Normalizes a `returnTo` value into a safe, router-relative destination.
 *
 * `returnTo` comes from the URL, so it is untrusted: only same-site absolute
 * paths are accepted, and protocol-relative values (`//evil.example`) are
 * rejected so sign-in cannot be turned into an open redirect.
 */
export function resolveReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return "/";
  }

  return stripRouterBasename(returnTo);
}
