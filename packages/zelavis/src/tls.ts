/**
 * TLS provider interface — the seam between zelavis and "where do I get
 * a cert+key for this hostname".
 *
 * Why this exists as an interface, not core code:
 *
 * - On self-hosted Node/Bun, users want different strategies: drop a
 *   PEM into a file and point at it, get one from Let's Encrypt via
 *   ACME, share a cert with a sibling service via a KV store, generate
 *   a self-signed cert for local dev.
 *
 * The interface is intentionally minimal — `getCertificate(hostname)`
 * returns a cert or undefined. Implementations can be backed by any of
 * the above; `chainTlsProviders` composes them so a user can layer
 * "uploaded override → ACME → self-signed dev fallback" without each
 * provider knowing about the others.
 *
 * This PR ships the interface + the simplest implementation: an in-memory
 * manual map. ACME / Let's Encrypt support arrives in a follow-up PR with its
 * own certificate caching + renewal logic.
 *
 * **Integration with the listening socket** is also a follow-up
 * concern: PR-A defines the seam; the Node/Bun adapter wiring (passing
 * provider → `https.createServer` SNI callback) lands when self-host
 * TLS becomes a real surface. Until then, providers are a typed
 * resource on the platform context that adapters and downstream code
 * can consume.
 */

/**
 * A TLS certificate as PEM-encoded cert chain + private key.
 *
 * `expiresAt` is advisory — callers can use it to schedule renewals
 * without having to parse the cert chain themselves. Providers that
 * can't determine expiry (e.g. manually uploaded certs) may leave it
 * undefined; consumers should not assume "undefined means never
 * expires".
 *
 * `hostnames` lists the hosts this cert is valid for. Useful for
 * wildcard certs and SAN entries — a single cert can cover
 * `example.com`, `www.example.com`, and `*.api.example.com`. Providers
 * that can't enumerate (or won't bother) leave it undefined; consumers
 * fall back to "trust the lookup that found this cert".
 */
export interface TlsCertificate {
  /** PEM-encoded certificate chain (leaf + intermediates). */
  cert: string | Uint8Array;
  /** PEM-encoded private key. */
  key: string | Uint8Array;
  /** Optional CA bundle if the cert chain doesn't include intermediates. */
  ca?: string | Uint8Array;
  /** When this cert is no longer valid. Advisory; for renewal scheduling. */
  expiresAt?: Date;
  /** Hostnames this cert covers (CN + SANs). */
  hostnames?: readonly string[];
}

export interface TlsProvider {
  /** Provider name, surfaced in diagnostics / admin UIs. */
  name: string;
  /**
   * Resolve a cert for `hostname`. Return `undefined` to signal "I
   * don't have one" — callers can chain providers and try the next.
   *
   * Implementations should normalize `hostname` to lowercase
   * internally; callers should not have to think about case.
   *
   * Wildcard handling: it's up to the provider whether `*.example.com`
   * matches `foo.example.com`. The `chainTlsProviders` helper does
   * exact-string lookups only; providers that want wildcard semantics
   * implement them themselves.
   */
  getCertificate(
    hostname: string,
  ):
    | Promise<TlsCertificate | undefined>
    | TlsCertificate
    | undefined;
  /**
   * Optional: enumerate hostnames this provider currently has certs
   * for. Used by admin UIs and by SNI-preload setups. Providers that
   * generate certs on demand (e.g. ACME with no preload) may leave
   * this undefined.
   */
  listHostnames?():
    | Promise<readonly string[]>
    | readonly string[];
}

/**
 * No-op provider for environments where TLS is terminated outside the zelavis
 * process, such as behind a reverse proxy (nginx/Caddy) that owns the cert.
 *
 * Returns `undefined` for every hostname; chains pass through to the
 * next provider, and self-hosted code paths that need a cert get a
 * clear "nothing here" signal.
 *
 * The reason this trivial provider exists at all: adapters can communicate
 * "TLS is handled outside this process" to downstream code instead of leaving
 * `tls` undefined, which is ambiguous.
 */
export function createExternalTlsProvider(): TlsProvider {
  return {
    name: "external",
    getCertificate: () => undefined,
    listHostnames: () => [],
  };
}

export interface ManualTlsProviderOptions {
  /**
   * Map from hostname to certificate. The sentinel key `"*"` acts as
   * a default that matches any host the explicit entries don't cover.
   * Wildcard patterns like `"*.example.com"` are matched literally as
   * "the hostname `*.example.com`", NOT as a glob — for glob-style
   * wildcards, the provider's caller should expand the map at
   * configuration time.
   *
   * Hostnames are normalized to lowercase on read AND on lookup, so
   * case sensitivity doesn't trip anyone up.
   */
  certificates: Record<string, TlsCertificate>;
}

/**
 * In-memory provider backed by a hostname-to-cert map. Suitable for:
 *
 * - Self-hosted deployments where an operator drops PEM files into
 *   config and the process loads them at boot.
 * - Test harnesses that need deterministic cert behavior.
 * - As the inner layer of a chain — a manual override for specific
 *   hosts ahead of an automatic provider (ACME) that handles the rest.
 */
export function createManualTlsProvider(
  options: ManualTlsProviderOptions,
): TlsProvider {
  if (!options || typeof options !== "object") {
    throw new TypeError("createManualTlsProvider requires an options object.");
  }
  if (
    !options.certificates ||
    typeof options.certificates !== "object" ||
    Array.isArray(options.certificates)
  ) {
    throw new TypeError(
      "createManualTlsProvider requires a `certificates` map (host → cert).",
    );
  }

  // Snapshot + lowercase the map at construction time so we don't
  // re-walk it on every request and don't surprise callers who mutate
  // the source object later.
  const normalized = new Map<string, TlsCertificate>();
  for (const [host, cert] of Object.entries(options.certificates)) {
    if (!cert || typeof cert !== "object") {
      throw new TypeError(
        `createManualTlsProvider: certificate for "${host}" must be an object.`,
      );
    }
    if (
      !cert.cert ||
      (typeof cert.cert !== "string" && !(cert.cert instanceof Uint8Array))
    ) {
      throw new TypeError(
        `createManualTlsProvider: certificate for "${host}" must include a string or Uint8Array \`cert\`.`,
      );
    }
    if (
      !cert.key ||
      (typeof cert.key !== "string" && !(cert.key instanceof Uint8Array))
    ) {
      throw new TypeError(
        `createManualTlsProvider: certificate for "${host}" must include a string or Uint8Array \`key\`.`,
      );
    }
    normalized.set(host.toLowerCase(), cert);
  }

  return {
    name: "manual",
    getCertificate(hostname) {
      const key = hostname.toLowerCase();
      const direct = normalized.get(key);
      if (direct) {
        return direct;
      }
      // Sentinel default — only consulted after no exact match.
      return normalized.get("*");
    },
    listHostnames() {
      return [...normalized.keys()].filter((host) => host !== "*");
    },
  };
}

/**
 * Compose multiple providers into one. Each is consulted in order;
 * the first to return a cert wins. `listHostnames` returns the union
 * (deduped, sorted) so admin UIs can see everything the chain knows
 * about.
 *
 * Typical layering, outer to inner:
 *
 * 1. Manual override (operator-uploaded certs for specific hosts)
 * 2. Automatic provider (ACME / Let's Encrypt — future PR)
 * 3. Self-signed dev fallback (so local dev works without internet)
 *
 * `chainTlsProviders(manual, acme, devFallback)` gives you exactly
 * that ordering.
 */
export function chainTlsProviders(
  ...providers: readonly TlsProvider[]
): TlsProvider {
  return {
    name: providers.length === 0 ? "chain" : `chain(${providers.map((p) => p.name).join("→")})`,
    async getCertificate(hostname) {
      for (const provider of providers) {
        const cert = await provider.getCertificate(hostname);
        if (cert) {
          return cert;
        }
      }
      return undefined;
    },
    async listHostnames() {
      const all = new Set<string>();
      for (const provider of providers) {
        if (typeof provider.listHostnames !== "function") {
          continue;
        }
        const list = await provider.listHostnames();
        for (const host of list) {
          all.add(host);
        }
      }
      return [...all].sort();
    },
  };
}
