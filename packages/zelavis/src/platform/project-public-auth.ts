import type { ZelavisServerExecutionContext } from "../core/runtime/contracts.js";

/** The native Node App engine's fixed private mount, independent of its parent's mount. */
export const PROJECT_AUTH_ROOT = "/zelavis";
export const PROJECT_AUTH_API = `${PROJECT_AUTH_ROOT}/api/v1`;
const PRIVATE_SITE_AUTH = `${PROJECT_AUTH_ROOT}/_site-auth`;
export const PROJECT_AUTH_BODY_BYTES = 8192;

export type ProjectPublicAuthRoute = "page" | "asset" | "api" | "webhook";

const pages = new Set([
  "/login", "/sign-up", "/forgot-password", "/reset-password", "/verify-email", "/change-email", "/mfa", "/oauth/callback",
  "/invitation",
  "/account", "/account/passkeys", "/account/two-factor", "/account/emails", "/account/password", "/account/sessions",
]);
const assets = new Set(["/auth-assets/identity.js", "/auth-assets/identity.css"]);
/**
 * The App's own Auth routes a visitor of its public origin may call: sign-up, sign-in, recovery and every route that
 * acts only on the caller's own session or account. Settings and administration (`/auth/*` routes that require a
 * permission) are never public; an operator reaches them through the Gateway.
 */
const publicAuthRoutes: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["GET", [
    "/auth/session", "/auth/sessions", "/auth/jwks", "/auth/registration", "/auth/methods", "/auth/emails",
    "/auth/oauth/providers", "/auth/oauth/:provider/callback", "/auth/passkeys", "/auth/mfa",
  ]],
  ["POST", [
    "/auth/invitations/accept",
    "/auth/session/refresh", "/auth/sessions/revoke-others",
    "/auth/username-password/sign-up", "/auth/username-password/sign-in", "/auth/username-password/change-password",
    "/auth/email-password/sign-up", "/auth/email-password/complete-sign-up", "/auth/email-password/sign-in",
    "/auth/email-password/change-password", "/auth/email-password/change-email/start", "/auth/email-password/change-email/complete",
    "/auth/email-password/recovery/start", "/auth/email-password/recovery/check", "/auth/email-password/recovery/complete",
    "/auth/emails/add/start", "/auth/emails/add/complete",
    "/auth/oauth/:provider/start", "/auth/oauth/:provider/callback", "/auth/oauth/:provider/redeem",
    "/auth/username-passkey/sign-up/start", "/auth/username-passkey/sign-up/finish",
    "/auth/username-passkey/sign-in/start", "/auth/username-passkey/sign-in/autofill", "/auth/username-passkey/sign-in/finish",
    "/auth/passkeys/add/start", "/auth/passkeys/add/verify", "/auth/passkeys/add/finish",
    "/auth/passkeys/:passkeyId/remove/start", "/auth/passkeys/:passkeyId/remove/finish",
    "/auth/mfa/totp", "/auth/mfa/totp/confirm", "/auth/mfa/verify", "/auth/mfa/backup-codes",
  ]],
  ["PATCH", ["/auth/passkeys/:passkeyId"]],
  ["DELETE", ["/auth/session", "/auth/sessions/:sessionId", "/auth/mfa/totp/:totpId"]],
]);
const reserved = new Set(["settings", "connections", "add"]);
const matchesTemplate = (template: string, path: string): boolean => {
  const want = template.split("/");
  const have = path.split("/");
  return want.length === have.length && want.every((segment, index) => segment.startsWith(":")
    ? /^[A-Za-z0-9_.~%-]+$/u.test(have[index] ?? "") && !reserved.has(have[index] ?? "")
    : segment === have[index]);
};
const isPublicAuthRoute = (method: string, path: string): boolean =>
  (publicAuthRoutes.get(method) ?? []).some((template) => matchesTemplate(template, path));

/** The public provider-callback convention; owning services must verify the raw-body signature. */
export function isProjectServiceWebhook(method: string, pathname: string, apiBasePath = PROJECT_AUTH_API): boolean {
  if (method !== "POST" || !pathname.startsWith(`${apiBasePath}/plugins/`)) return false;
  return /^plugins\/[a-z][A-Za-z0-9]{0,63}\/webhooks\/[a-z][a-z0-9_-]{0,63}$/u.test(pathname.slice(apiBasePath.length + 1));
}

export function classifyProjectPublicAuthRequest(method: string, pathname: string, rootPath: string, apiBasePath: string): ProjectPublicAuthRoute | undefined {
  const mount = rootPath === "/" ? "" : rootPath;
  if (method === "GET" && pathname.startsWith(`${mount}/`)) {
    const relative = pathname.slice(mount.length);
    if (pages.has(relative)) return "page";
    if (assets.has(relative)) return "asset";
  }
  if (isProjectServiceWebhook(method, pathname, apiBasePath)) return "webhook";
  if (pathname.startsWith(`${apiBasePath}/`) && isPublicAuthRoute(method, pathname.slice(apiBasePath.length))) return "api";
  return undefined;
}

/**
 * An installed Platform can forward requests to an App still locked to a
 * published engine. Its worker accepts its own historical route contract.
 * Current workers use classifyProjectPublicAuthRequest and refuse those paths.
 */
const publishedIdentityPosts = new Set([
  "/auth/sign-up/password", "/auth/authenticate/password", "/auth/session/rotate",
]);
export function classifyProjectPublicAuthIngress(method: string, pathname: string): ProjectPublicAuthRoute | undefined {
  return classifyProjectPublicAuthRequest(method, pathname, PROJECT_AUTH_ROOT, PROJECT_AUTH_API) ??
    (method === "POST" && pathname.startsWith(`${PROJECT_AUTH_API}/`) &&
      publishedIdentityPosts.has(pathname.slice(PROJECT_AUTH_API.length)) ? "api" : undefined);
}

/** A dedicated worker path keeps old engines and site frontends from handling these requests.
 * All transport requests use POST because a site's catch-all can answer GET; the original method travels in the path.
 */
export function privateProjectAuthPath(method: string, pathname: string): string {
  return `${PRIVATE_SITE_AUTH}/${method}${pathname.slice(PROJECT_AUTH_ROOT.length)}`;
}

export function isPrivateProjectAuthPath(pathname: string): boolean {
  return pathname === PRIVATE_SITE_AUTH || pathname.startsWith(`${PRIVATE_SITE_AUTH}/`);
}

export function publicRequestFromPrivateAuth(request: Request): Request | undefined {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith(`${PRIVATE_SITE_AUTH}/`)) return undefined;
  const relative = url.pathname.slice(PRIVATE_SITE_AUTH.length + 1);
  const separator = relative.indexOf("/");
  if (separator < 0) return undefined;
  const method = relative.slice(0, separator);
  url.pathname = `${PROJECT_AUTH_ROOT}${relative.slice(separator)}`;
  if (!classifyProjectPublicAuthRequest(method, url.pathname, PROJECT_AUTH_ROOT, PROJECT_AUTH_API)) return undefined;
  const body = method === "GET" ? undefined : request.body;
  return new Request(url, { method, headers: request.headers, signal: request.signal, ...(body ? { body, duplex: "half" } as RequestInit : {}) });
}

/** Node retains the raw target even when the Web URL normalized dot segments or backslashes. */
export function hasCanonicalSitePath(request: Request, context?: ZelavisServerExecutionContext): boolean {
  const platform = context?.platform as { node?: { request?: { url?: string } } } | undefined;
  const raw = platform?.node?.request?.url;
  return raw === undefined || raw.split("?", 1)[0] === new URL(request.url).pathname;
}

export function isSiteControlPlanePath(pathname: string, rootPath: string): boolean {
  const path = pathname.replace(/\\/gu, "/").replace(/\/{2,}/gu, "/").toLowerCase();
  const root = rootPath.toLowerCase();
  return path === root || path.startsWith(`${root}/`);
}
