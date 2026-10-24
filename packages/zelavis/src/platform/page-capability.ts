/**
 * A capability to read one service's page files without credentials.
 *
 * A page an extension ships runs in a sandboxed frame with an opaque origin: the frame's own document is fetched with
 * the dashboard's session, but everything it then loads (its scripts, styles, images) is requested by the frame and
 * carries no cookie. The Platform therefore hands the dashboard a URL with a signed token in its path. Relative links
 * in the page resolve under that path, so each one carries the capability with it, and the token alone authorizes the
 * read: it names a service, a bundle and (for a Project's page) the Project, and expires. It can read that bundle's
 * static files and nothing else, because the Platform builds the path it forwards from the claims, never from the request.
 */
import { Effect } from "effect";
import { integration, integrationValue, present, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { buildBundleStorageKey } from "../bundle-store.js";

export interface PageCapabilityClaims {
  readonly service: string;
  readonly bundle: string;
  /** Present when the page belongs to a Project, whose runtime serves its files. */
  readonly projectId?: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** Long enough for a page left open in a tab to keep loading what it imports lazily; the dashboard mints a fresh one per mount. */
export const PAGE_CAPABILITY_LIFETIME_MS = 8 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try { binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")); } catch { return undefined; }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The key is derived from the installation secret for this one purpose, so it signs nothing else. */
function key(secret: string): Promise<CryptoKey> {
  return present(integration(() => crypto.subtle.importKey(
    "raw", encoder.encode(`${secret}\u0000service-page-capability`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  )));
}

const payloadOf = (claims: PageCapabilityClaims) => JSON.stringify([claims.service, claims.bundle, claims.projectId ?? "", claims.expiresAt]);

/** `payload.signature`, both base64url. */
export function mintPageCapability(secret: string, claims: PageCapabilityClaims): Promise<string> {
  return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    const payload = encoder.encode(payloadOf(claims));
    const signature = yield* integrationValue(crypto.subtle.sign("HMAC", yield* integrationValue(key(secret)), payload));
    return `${encode(payload)}.${encode(new Uint8Array(signature))}`;
  }));
}

/** The claims of an unexpired, authentic token; `undefined` for anything else, which is simply not authorized. */
export function verifyPageCapability(secret: string, token: string, now = Date.now()): Promise<PageCapabilityClaims | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<PageCapabilityClaims | undefined, IntegrationFailure> {
    const separator = token.indexOf(".");
    if (separator <= 0 || separator === token.length - 1 || token.length > 2048) return undefined;
    const payload = decode(token.slice(0, separator));
    const signature = decode(token.slice(separator + 1));
    if (!payload || !signature) return undefined;
    const valid = yield* integrationValue(crypto.subtle.verify("HMAC", yield* integrationValue(key(secret)), signature, payload));
    if (!valid) return undefined;
    const decoded = yield* Effect.try({ try: () => JSON.parse(new TextDecoder().decode(payload)) as unknown, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
    if (!Array.isArray(decoded) || decoded.length !== 4) return undefined;
    const [service, bundle, projectId, expiresAt] = decoded as unknown[];
    if (typeof service !== "string" || !service || typeof bundle !== "string" || !bundle || typeof projectId !== "string" || typeof expiresAt !== "number") return undefined;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;
    // Authenticity does not substitute for valid namespace boundaries.
    const scope = { serviceName: service, bundle, ...(projectId ? { projectId } : {}) };
    const safe = yield* Effect.try({ try: () => buildBundleStorageKey(scope, ""), catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
    if (!safe) return undefined;
    return { service, bundle, ...(projectId ? { projectId } : {}), expiresAt };
  }));
}

/**
 * What the Platform asks a Project's runtime for on a capability's behalf. The path is built from the claims and the
 * requested file, never taken whole from the request, and the principal is the Platform's own service-page one with no
 * permission at all: the runtime's page-asset route asks only for an authenticated caller, so only page files answer.
 */
export function projectPageRequest(claims: PageCapabilityClaims & { readonly projectId: string }, file: string): {
  readonly projectId: string;
  readonly wildcardPath: string;
  readonly principal: { readonly id: string; readonly type: "service" };
  readonly permissions: readonly string[];
} {
  buildBundleStorageKey({ serviceName: claims.service, bundle: claims.bundle, projectId: claims.projectId }, file);
  return {
    projectId: claims.projectId,
    wildcardPath: `zelavis/api/v1/runtime/service-page-assets/${encodeURIComponent(claims.service)}/${encodeURIComponent(claims.bundle)}/${file.split("/").map(encodeURIComponent).join("/")}`,
    principal: { id: "service-page", type: "service" },
    permissions: [],
  };
}
