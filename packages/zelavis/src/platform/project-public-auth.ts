import type { ZelavisServerExecutionContext } from "../core/runtime/contracts.js";

/** The native Node App engine's fixed private mount, independent of its parent's mount. */
export const PROJECT_AUTH_ROOT = "/zelavis";
export const PROJECT_AUTH_API = `${PROJECT_AUTH_ROOT}/api/v1`;
const PRIVATE_SITE_AUTH = `${PROJECT_AUTH_ROOT}/_site-auth`;
export const PROJECT_AUTH_BODY_BYTES = 8192;

export type ProjectPublicAuthRoute = "page" | "asset" | "api";

const pages = new Set(["/login", "/sign-up"]);
const assets = new Set(["/auth-assets/identity.js", "/auth-assets/identity.css"]);
const authMethods: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["GET", new Set(["/auth/registration", "/auth/session"])],
  ["POST", new Set(["/auth/sign-up/password", "/auth/authenticate/password", "/auth/session/rotate"])],
  ["DELETE", new Set(["/auth/session"])],
]);

export function classifyProjectPublicAuthRequest(method: string, pathname: string, rootPath: string, apiBasePath: string): ProjectPublicAuthRoute | undefined {
  const mount = rootPath === "/" ? "" : rootPath;
  if (method === "GET" && pathname.startsWith(`${mount}/`)) {
    const relative = pathname.slice(mount.length);
    if (pages.has(relative)) return "page";
    if (assets.has(relative)) return "asset";
  }
  if (pathname.startsWith(`${apiBasePath}/`) && authMethods.get(method)?.has(pathname.slice(apiBasePath.length))) return "api";
  return undefined;
}

/** A dedicated worker path keeps old engines and site frontends from handling these requests.
 * All transport requests use POST because a site's catch-all can answer GET.
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
  const body = method === "POST" ? request.body : undefined;
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
