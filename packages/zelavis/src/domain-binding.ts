/**
 * Domain bindings — the seam between "an operator verified `acme.com`
 * for a workspace/service" and "the dispatcher actually routes requests
 * for `acme.com` to that service".
 *
 * The risk this addresses: a workspace service (uploaded ZIP, marketplace
 * install) must not be able to claim arbitrary hostnames from its own
 * service definition. Without a verified runtime binding, a tenant could
 * squat google.com or a sister tenant's hostname and the dispatcher
 * would happily serve them. That's a security hole.
 *
 * The model is intentionally boring: bindings are stored objects with
 * a `verifiedAt` timestamp. Verification flips the field. The
 * synthesized route matcher only honors hosts that have a verified
 * binding pointing to this workspace+service. Unverified bindings are
 * still stored (so admin UIs can show the pending state and reuse the
 * generated verification token) but don't influence routing.
 *
 * **Verification methods are a follow-up concern.** This PR ships the
 * model, the store interface + two reference implementations, the
 * token generator, and a `manual` verification helper for the
 * out-of-band case. The DNS-TXT and HTTP-01 verifiers land in the next
 * PR alongside the ACME provider, which has the same shape.
 *
 * **Ownership uniqueness:** a host can have at most one binding
 * across all workspaces. Adding a second binding for the same host
 * throws. This prevents two workspaces from independently "verifying"
 * the same hostname.
 */

import type { ZelavisKeyValueStore } from "./index.js";

/**
 * Verification method used to prove control of the host.
 *
 * - `manual` — operator marks the binding verified out of band. Useful
 *   for first-party domains the operator already controls, or for
 *   testing.
 * - `dns-txt` — verifier resolves `_zelavis-challenge.<host>` and
 *   compares the TXT record to the binding's `verificationToken`.
 * - `http-01` — verifier fetches
 *   `http://<host>/.well-known/zelavis-challenge/<token>` and expects
 *   the body to echo the token. Only works if the host already points
 *   at this zelavis instance — typical second step after DNS-TXT.
 */
export type DomainVerificationMethod = "manual" | "dns-txt" | "http-01";

export interface DomainBinding {
  /** Lowercase hostname. Unique across the store. */
  host: string;
  /**
   * Owning workspace. Omitted (undefined) for system-level bindings
   * the operator installs directly.
   */
  workspaceId?: string;
  /**
   * Service this binding is dedicated to. Omitted means the binding is
   * workspace-level — any service in that workspace can use the host
   * when its app policy allows host-bound routing.
   */
  serviceName?: string;
  /**
   * Random URL-safe token tied to this binding. The DNS-TXT / HTTP-01
   * verifiers compare this against external evidence; the `manual`
   * verifier ignores it but it's still issued so verifiers can be
   * swapped in later without re-creating the binding.
   */
  verificationToken: string;
  /**
   * When verification succeeded. Undefined means pending — the
   * dispatcher must NOT match host-bound routes against unverified
   * bindings.
   */
  verifiedAt?: string;
  /**
   * Which method succeeded (filled when `verifiedAt` is set). Useful
   * for audit logs and admin UIs.
   */
  verificationMethod?: DomainVerificationMethod;
  /** ISO timestamp when the binding was first created. */
  createdAt: string;
  /** ISO timestamp of the last mutation. */
  updatedAt: string;
  /** Free-form labels for admin UIs / integrations. */
  metadata?: Record<string, string>;
}

export interface DomainBindingStore {
  /**
   * Look up a binding by host. Returns `undefined` if none exists.
   * Implementations should normalize the input to lowercase before
   * lookup; callers should not have to.
   */
  get(host: string): Promise<DomainBinding | undefined>;
  /**
   * Persist a binding. The implementation is the source of truth for
   * uniqueness: if a binding already exists for `host` and `mode`
   * isn't `"upsert"`, the store throws.
   */
  put(
    binding: DomainBinding,
    mode?: "insert" | "upsert",
  ): Promise<DomainBinding>;
  /** Remove a binding by host. Returns `true` iff something was removed. */
  delete(host: string): Promise<boolean>;
  /**
   * Enumerate bindings, optionally filtered by ownership. Returns a
   * stable order (sorted by host ascending) so admin UIs and tests
   * are deterministic.
   */
  list(
    filter?: { workspaceId?: string; serviceName?: string; verifiedOnly?: boolean },
  ): Promise<readonly DomainBinding[]>;
}

const RANDOM_TOKEN_BYTES = 32;

/**
 * Generate a URL-safe random token suitable for `verificationToken`.
 *
 * Uses Web Crypto via `globalThis.crypto.getRandomValues`, available in
 * Node 19+, Bun, Deno, and modern browsers. Encodes as
 * URL-safe base64 (no padding, `+` and `/` swapped for `-` and `_`)
 * so the token can be dropped into DNS TXT records and URL paths
 * without escaping.
 */
export function generateVerificationToken(byteLength = RANDOM_TOKEN_BYTES): string {
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    throw new Error(
      "generateVerificationToken requires a Web Crypto-capable runtime.",
    );
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toUrlSafeBase64(bytes);
}

function toUrlSafeBase64(bytes: Uint8Array): string {
  // Browser-style base64 via btoa-equivalent. Done by hand to avoid
  // depending on a Buffer/atob branch that differs across runtimes.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += alphabet[a >> 2];
    out += alphabet[((a & 0b11) << 4) | (b >> 4)];
    out += alphabet[((b & 0b1111) << 2) | (c >> 6)];
    out += alphabet[c & 0b111111];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    out += alphabet[a >> 2];
    out += alphabet[((a & 0b11) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      out += alphabet[(b & 0b1111) << 2];
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) {
    throw new TypeError("Domain binding host must be a non-empty string.");
  }
  return host.toLowerCase().replace(/\.+$/, "");
}

/**
 * Create a binding in the store, generating a fresh verification token
 * and timestamps. Throws if a binding already exists for the host.
 *
 * The returned binding is the one that landed in the store — callers
 * should display `binding.verificationToken` to the operator so they
 * can complete the chosen verification method.
 */
export async function addDomainBinding(
  store: DomainBindingStore,
  options: {
    host: string;
    workspaceId?: string;
    serviceName?: string;
    metadata?: Record<string, string>;
  },
): Promise<DomainBinding> {
  const host = normalizeHost(options.host);
  const now = nowIso();
  const binding: DomainBinding = {
    host,
    workspaceId: options.workspaceId,
    serviceName: options.serviceName,
    verificationToken: generateVerificationToken(),
    createdAt: now,
    updatedAt: now,
    metadata: options.metadata,
  };
  return store.put(binding, "insert");
}

/**
 * Mark a binding verified by manual attestation. The operator is
 * claiming "I verified this out of band" — the store records the
 * timestamp but doesn't validate the claim. Useful for first-party
 * domains the operator already controls.
 *
 * Throws if no binding exists for the host.
 */
export async function verifyDomainBindingManually(
  store: DomainBindingStore,
  host: string,
): Promise<DomainBinding> {
  const normalized = normalizeHost(host);
  const existing = await store.get(normalized);
  if (!existing) {
    throw new Error(`No domain binding exists for "${normalized}".`);
  }
  const now = nowIso();
  const updated: DomainBinding = {
    ...existing,
    verifiedAt: now,
    verificationMethod: "manual",
    updatedAt: now,
  };
  return store.put(updated, "upsert");
}

/**
 * Revoke a binding's verification. The binding stays in the store
 * (so the verification token survives for re-verification) but
 * routing for the host stops working immediately. Operators use this
 * when they suspect a domain was hijacked or no longer want it bound.
 */
export async function revokeDomainBindingVerification(
  store: DomainBindingStore,
  host: string,
): Promise<DomainBinding | undefined> {
  const normalized = normalizeHost(host);
  const existing = await store.get(normalized);
  if (!existing) {
    return undefined;
  }
  const now = nowIso();
  const updated: DomainBinding = {
    ...existing,
    verifiedAt: undefined,
    verificationMethod: undefined,
    updatedAt: now,
  };
  return store.put(updated, "upsert");
}

/**
 * In-memory store. The simplest backend; suitable for tests, ephemeral
 * deployments (everything resets on restart), and as a Map in front
 * of a slower persistent store during development.
 */
export function createInMemoryDomainBindingStore(
  seed: readonly DomainBinding[] = [],
): DomainBindingStore {
  const bindings = new Map<string, DomainBinding>();
  for (const binding of seed) {
    bindings.set(normalizeHost(binding.host), Object.freeze({ ...binding }));
  }

  return {
    async get(host) {
      return bindings.get(normalizeHost(host));
    },
    async put(binding, mode = "insert") {
      const host = normalizeHost(binding.host);
      const existing = bindings.get(host);
      if (existing && mode === "insert") {
        throw new Error(
          `Domain binding for "${host}" already exists; use mode "upsert" to replace.`,
        );
      }
      const frozen = Object.freeze({ ...binding, host });
      bindings.set(host, frozen);
      return frozen;
    },
    async delete(host) {
      return bindings.delete(normalizeHost(host));
    },
    async list(filter = {}) {
      const out: DomainBinding[] = [];
      for (const binding of bindings.values()) {
        if (
          filter.workspaceId !== undefined &&
          binding.workspaceId !== filter.workspaceId
        ) {
          continue;
        }
        if (
          filter.serviceName !== undefined &&
          binding.serviceName !== filter.serviceName
        ) {
          continue;
        }
        if (filter.verifiedOnly && !binding.verifiedAt) {
          continue;
        }
        out.push(binding);
      }
      out.sort((left, right) => left.host.localeCompare(right.host));
      return out;
    },
  };
}

export interface CreateKeyValueDomainBindingStoreOptions {
  /** Backing store. Required. */
  store: ZelavisKeyValueStore;
  /**
   * Key prefix under which bindings live, so they don't collide with
   * other consumers of the same KV store. Default `"domain-bindings"`.
   */
  prefix?: string;
}

/**
 * Store backed by a `ZelavisKeyValueStore`. Suitable for any backend the host
 * has wired up (Node's in-memory dev KV, a Redis adapter, or another
 * list-capable key/value backend). Bindings are JSON-encoded under
 * `<prefix>/<host>`.
 *
 * The optional `list` capability of `ZelavisKeyValueStore` is required
 * — without it, the store can't enumerate bindings and `list()` will
 * throw. In practice every adapter ships a `list`-capable KV; the
 * runtime check exists so misconfiguration surfaces clearly.
 */
export function createKeyValueDomainBindingStore(
  options: CreateKeyValueDomainBindingStoreOptions,
): DomainBindingStore {
  if (!options?.store) {
    throw new TypeError(
      "createKeyValueDomainBindingStore requires a `store` (ZelavisKeyValueStore).",
    );
  }
  const prefix = (options.prefix ?? "domain-bindings").replace(/\/+$/, "");
  const keyFor = (host: string) => `${prefix}/${host}`;
  const hostFromKey = (key: string) => key.slice(prefix.length + 1);

  return {
    async get(host) {
      const normalized = normalizeHost(host);
      const raw = await options.store.get(keyFor(normalized));
      if (!raw) {
        return undefined;
      }
      try {
        const parsed = JSON.parse(raw) as DomainBinding;
        return parsed;
      } catch {
        // Corrupt entry — treat as missing. Surfacing a parse error
        // would block routing on a bad row; deleting silently isn't
        // safe (operator should investigate). Returning undefined
        // lets admin UIs surface the bad key separately if needed.
        return undefined;
      }
    },
    async put(binding, mode = "insert") {
      const host = normalizeHost(binding.host);
      const key = keyFor(host);
      if (mode === "insert") {
        const existing = await options.store.get(key);
        if (existing) {
          throw new Error(
            `Domain binding for "${host}" already exists; use mode "upsert" to replace.`,
          );
        }
      }
      const stored = { ...binding, host };
      await options.store.set(key, JSON.stringify(stored));
      return stored;
    },
    async delete(host) {
      return options.store.delete(keyFor(normalizeHost(host)));
    },
    async list(filter = {}) {
      if (typeof options.store.list !== "function") {
        throw new Error(
          "createKeyValueDomainBindingStore: backing KV store does not implement list().",
        );
      }
      const keys = await options.store.list(prefix);
      const out: DomainBinding[] = [];
      for (const key of keys) {
        const raw = await options.store.get(key);
        if (!raw) {
          continue;
        }
        let binding: DomainBinding;
        try {
          binding = JSON.parse(raw);
        } catch {
          continue;
        }
        // The key carries the host; trust it over a possibly stale
        // value inside the binding object.
        binding.host = hostFromKey(key);
        if (
          filter.workspaceId !== undefined &&
          binding.workspaceId !== filter.workspaceId
        ) {
          continue;
        }
        if (
          filter.serviceName !== undefined &&
          binding.serviceName !== filter.serviceName
        ) {
          continue;
        }
        if (filter.verifiedOnly && !binding.verifiedAt) {
          continue;
        }
        out.push(binding);
      }
      out.sort((left, right) => left.host.localeCompare(right.host));
      return out;
    },
  };
}

/**
 * Return verified hostnames the service is authorized to serve, per the
 * binding store.
 *
 * System-scope services are host-agnostic here: the operator decides how
 * they are mounted. Workspace-scope services only get hosts where:
 *   - a verified binding exists
 *   - the binding's workspace matches this service's workspace
 *   - the binding is either workspace-wide or dedicated to this service
 *
 * Used by `synthesizeServiceAppService` so service app definitions stay
 * portable: concrete hostnames live in runtime activation state instead
 * of inside the service package.
 */
export async function listAuthorizedHostsForService(
  options: {
    scope: "system" | "workspace";
    workspaceId?: string;
    serviceName: string;
    domainBindings?: DomainBindingStore;
  },
): Promise<readonly string[]> {
  if (options.scope === "system") {
    return [];
  }
  if (!options.domainBindings || !options.workspaceId) {
    // No store configured → no way to verify → no host-bound routing.
    // No workspace ownership → no safe binding lookup.
    // Returning [] here means the synthesizer won't emit host matchers;
    // the service still works at its path-based `/apps/<name>` mount.
    return [];
  }

  const bindings = await options.domainBindings.list({
    workspaceId: options.workspaceId,
    verifiedOnly: true,
  });
  const allowed: string[] = [];
  for (const binding of bindings) {
    if (binding.host === "*") {
      continue;
    }
    if (
      binding.serviceName !== undefined &&
      binding.serviceName !== options.serviceName
    ) {
      continue;
    }
    allowed.push(binding.host);
  }
  return Object.freeze(allowed);
}
