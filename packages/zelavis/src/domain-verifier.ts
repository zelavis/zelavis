/**
 * Domain-binding verifiers — the runtime-agnostic checks that prove
 * an operator controls a hostname before the dispatcher lets them
 * route traffic from it.
 *
 * The store layer (`domain-binding.ts`) already supports `manual`
 * verification — an operator says "I checked out of band". That's
 * fine for first-party domains the operator already owns, but
 * tenant-facing flows need automatic proof. This module ships the two
 * standard methods:
 *
 * - **DNS-TXT** (`verifyDomainBindingViaDns`): resolve a TXT record at
 *   `_zelavis-challenge.<host>` and compare against the binding's
 *   `verificationToken`. Works without the host yet pointing at this
 *   zelavis instance — useful as the first step before DNS cutover.
 *
 * - **HTTP-01** (`verifyDomainBindingViaHttp`): fetch
 *   `http://<host>/.well-known/zelavis-challenge/<token>` and confirm
 *   the body echoes the token. Requires the host to already resolve
 *   to a zelavis instance. The matching server-side endpoint is
 *   shipped here as `createDomainChallengeService` — when a binding
 *   exists for the request host, the endpoint returns the binding's
 *   token; otherwise 404.
 *
 * Both methods flip `verifiedAt` and `verificationMethod` on the
 * binding the same way `verifyDomainBindingManually` does, so the
 * downstream gating (`listAuthorizedHostsForService`) is unchanged.
 *
 * **Runtime portability:** DNS and HTTP both have runtime-specific
 * APIs. We use injectable `DnsTxtResolver` + `fetch` so callers can
 * supply Node's `dns/promises`, a DNS-over-HTTPS resolver, a mock for tests,
 * etc. The default resolver lazy-imports `node:dns/promises` — available on
 * Node 18+, Bun, and future Deno support.
 */

import type { ZelavisRuntimeService, ZelavisServerRoute } from "./core/index.js";
import type { DomainBinding, DomainBindingStore } from "./domain-binding.js";

const DEFAULT_DNS_CHALLENGE_PREFIX = "_zelavis-challenge";
const DEFAULT_HTTP_CHALLENGE_PATH = "/.well-known/zelavis-challenge";

type NodeDnsPromisesModule = {
  resolveTxt(host: string): Promise<string[][]>;
};

/**
 * Minimal DNS-TXT resolver interface. Mirrors the shape of Node's
 * `dns.promises.resolveTxt` so the default implementation is a thin
 * passthrough; other backends (DoH, a mock in tests) just
 * have to produce the same array-of-strings shape.
 *
 * Implementations should throw on DNS lookup failure (`ENOTFOUND`,
 * `ENODATA`, etc.) — callers translate those into "verification failed"
 * with a clear error message.
 */
export interface DnsTxtResolver {
  /**
   * Return the TXT records at `host`. Each record is an array of
   * string fragments per RFC 1035 (a single TXT record may be split
   * into multiple <=255-byte strings); we concatenate them inside the
   * verifier.
   */
  resolveTxt(host: string): Promise<readonly (readonly string[])[]>;
}

/**
 * Default Node-based resolver. Lazy-loads `node:dns/promises` on first
 * call so this module remains importable in environments without
 * `node:` builtins. If the import fails, the
 * resolver throws with a clear message pointing at the alternative
 * (inject your own).
 */
export function createNodeDnsTxtResolver(): DnsTxtResolver {
  let cached: Promise<(host: string) => Promise<string[][]>> | undefined;
  const load = () => {
    if (!cached) {
      cached = (async () => {
        try {
          const importRuntimeModule = new Function(
            "specifier",
            "return import(specifier)",
          ) as (specifier: string) => Promise<NodeDnsPromisesModule>;
          const dns = await importRuntimeModule("node:dns/promises");
          return dns.resolveTxt;
        } catch {
          throw new Error(
            "createNodeDnsTxtResolver: `node:dns/promises` is unavailable. " +
              "Provide a custom DnsTxtResolver implementation for this runtime.",
          );
        }
      })();
    }
    return cached;
  };

  return {
    async resolveTxt(host) {
      const resolveTxt = await load();
      return resolveTxt(host);
    },
  };
}

export interface VerifyDomainBindingViaDnsOptions {
  /**
   * DNS resolver to use. Defaults to `createNodeDnsTxtResolver()` on
   * the first call. Inject a custom one when running outside Node/Bun.
   */
  resolver?: DnsTxtResolver;
  /**
   * Subdomain prefix where the TXT record lives. Default
   * `"_zelavis-challenge"` (so for host `acme.com` we look at
   * `_zelavis-challenge.acme.com`). The leading underscore follows
   * the DNS-01 convention used by ACME; it makes the record visually
   * obvious as a verification artifact and avoids colliding with
   * application TXT records.
   */
  challengePrefix?: string;
}

let defaultResolver: DnsTxtResolver | undefined;

function getDefaultResolver(): DnsTxtResolver {
  defaultResolver ??= createNodeDnsTxtResolver();
  return defaultResolver;
}

function flattenTxtRecords(
  records: readonly (readonly string[])[],
): readonly string[] {
  return records.map((fragments) => fragments.join(""));
}

/**
 * Verify a domain binding via DNS-TXT. Resolves the configured
 * challenge record under the binding's host, looks for an exact match
 * against the binding's `verificationToken`, and flips
 * `verifiedAt`/`verificationMethod` on success.
 *
 * Throws if:
 *  - no binding exists for the host (operator should `addDomainBinding`
 *    first to get a token),
 *  - DNS resolution fails (network error, NXDOMAIN, no TXT records),
 *  - no TXT record matches the binding's token.
 *
 * The error message is intentionally specific so the operator can act:
 * "TXT records found but none matched" is different from "no TXT
 * records returned" is different from "DNS lookup failed".
 */
export async function verifyDomainBindingViaDns(
  store: DomainBindingStore,
  host: string,
  options: VerifyDomainBindingViaDnsOptions = {},
): Promise<DomainBinding> {
  const normalized = host.toLowerCase();
  const binding = await store.get(normalized);
  if (!binding) {
    throw new Error(`No domain binding exists for "${normalized}".`);
  }

  const prefix = options.challengePrefix ?? DEFAULT_DNS_CHALLENGE_PREFIX;
  const resolver = options.resolver ?? getDefaultResolver();
  const challengeHost = `${prefix}.${normalized}`;

  let records: readonly (readonly string[])[];
  try {
    records = await resolver.resolveTxt(challengeHost);
  } catch (error) {
    const cause =
      error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(
      `DNS-TXT lookup for "${challengeHost}" failed: ${cause}`,
    );
  }

  if (!records || records.length === 0) {
    throw new Error(`No TXT records returned for "${challengeHost}".`);
  }

  const flattened = flattenTxtRecords(records);
  if (!flattened.includes(binding.verificationToken)) {
    throw new Error(
      `TXT records at "${challengeHost}" did not include the expected token. ` +
        `Found ${flattened.length} record(s); none matched.`,
    );
  }

  const now = new Date().toISOString();
  return store.put(
    {
      ...binding,
      verifiedAt: now,
      verificationMethod: "dns-txt",
      updatedAt: now,
    },
    "upsert",
  );
}

export interface VerifyDomainBindingViaHttpOptions {
  /**
   * Fetch implementation. Defaults to `globalThis.fetch`. Inject in
   * tests or in runtimes where you want different timeout/proxy
   * behavior.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Path component for the challenge URL. Default
   * `/.well-known/zelavis-challenge`. The token is appended as the
   * final path segment.
   */
  challengePath?: string;
  /**
   * Whether to fetch over `http` or `https`. Default `"http"` — the
   * HTTP-01 convention is plain HTTP so the verifier doesn't depend
   * on a working TLS chain at the moment of verification (chicken-
   * and-egg with cert provisioning). Operators who insist on HTTPS
   * can override.
   */
  scheme?: "http" | "https";
  /**
   * Abort the fetch after `timeoutMs` milliseconds. Default 10_000.
   * Stops a misconfigured host from hanging the verification thread.
   */
  timeoutMs?: number;
}

/**
 * Verify a domain binding via HTTP-01. GETs
 * `<scheme>://<host>/<challengePath>/<token>` and confirms the body
 * matches the binding's `verificationToken`. Flips `verifiedAt` /
 * `verificationMethod` on success.
 *
 * This method only works if the host already resolves to a zelavis
 * instance (or an HTTP server the operator controls) that's serving
 * the challenge response. The matching server-side responder is
 * `createDomainChallengeService` — zelavis wires it in automatically
 * when `domainBindings` is configured, so any zelavis instance with
 * the binding will respond correctly without operator action beyond
 * pointing the DNS at it.
 *
 * Throws with method-specific reasons (network error, non-200
 * status, body mismatch) so operators can fix the right thing.
 */
export async function verifyDomainBindingViaHttp(
  store: DomainBindingStore,
  host: string,
  options: VerifyDomainBindingViaHttpOptions = {},
): Promise<DomainBinding> {
  const normalized = host.toLowerCase();
  const binding = await store.get(normalized);
  if (!binding) {
    throw new Error(`No domain binding exists for "${normalized}".`);
  }

  const scheme = options.scheme ?? "http";
  const path = (options.challengePath ?? DEFAULT_HTTP_CHALLENGE_PATH).replace(
    /\/+$/,
    "",
  );
  const url = `${scheme}://${normalized}${path}/${binding.verificationToken}`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "verifyDomainBindingViaHttp requires a fetch implementation; pass one via `options.fetch`.",
    );
  }

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    const cause =
      error instanceof Error ? error.message : String(error ?? "unknown");
    throw new Error(`HTTP-01 fetch of "${url}" failed: ${cause}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status !== 200) {
    throw new Error(
      `HTTP-01 fetch of "${url}" returned ${response.status}; expected 200.`,
    );
  }

  // Trim trailing whitespace — some webservers append newlines to
  // static files, and a strict equality check would spuriously fail.
  const body = (await response.text()).trim();
  if (body !== binding.verificationToken) {
    throw new Error(
      `HTTP-01 response body at "${url}" did not match the expected token.`,
    );
  }

  const now = new Date().toISOString();
  return store.put(
    {
      ...binding,
      verifiedAt: now,
      verificationMethod: "http-01",
      updatedAt: now,
    },
    "upsert",
  );
}

export interface CreateDomainChallengeServiceOptions {
  /**
   * Path under which the service responds. Default
   * `/.well-known/zelavis-challenge`. Operators who want a different
   * path (to align with another tool's expectations) can override —
   * both the verifier and the service need to use the matching path.
   */
  challengePath?: string;
}

/**
 * Service that serves the HTTP-01 challenge response for any binding
 * in the store. Mounted host-agnostically (`host: "*"`) so it answers
 * on whatever hostname the request came in on — and looks up the
 * binding by that hostname, returning the token only when:
 *
 *  1. a binding exists for the host,
 *  2. the URL token matches the binding's `verificationToken`.
 *
 * Anything else gets 404. The endpoint also serves unverified
 * bindings (that's the whole point — verification flips the field
 * AFTER the operator sees the endpoint responding correctly).
 *
 * Returns a regular `ZelavisRuntimeService` with `basePath: "/"` so the
 * route's full path is exactly the challenge URL.
 */
export function createDomainChallengeService(
  store: DomainBindingStore,
  options: CreateDomainChallengeServiceOptions = {},
): ZelavisRuntimeService {
  const path = (options.challengePath ?? DEFAULT_HTTP_CHALLENGE_PATH).replace(
    /\/+$/,
    "",
  );
  const routePath = `${path}/:token`;

  const route: ZelavisServerRoute<unknown> = {
    id: "zelavis.domain.challenge",
    method: "GET",
    path: routePath,
    handler: async ({ request, params }) => {
      const url = new URL(request.url);
      const host = url.host.toLowerCase();
      const binding = await store.get(host);
      if (!binding) {
        return { status: 404, body: "Not found" };
      }
      const offered = params?.token;
      if (typeof offered !== "string" || offered !== binding.verificationToken) {
        return { status: 404, body: "Not found" };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: binding.verificationToken,
      };
    },
  };

  return {
    name: "zelavis-domain-challenge",
    basePath: "/",
    service: {},
    api: { v1: [route] },
  };
}
