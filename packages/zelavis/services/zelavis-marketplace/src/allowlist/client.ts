import { verifyAllowlistEnvelope, type AllowlistKeyResolver } from "./envelope.js";
import {
  ALLOWLIST_MAX_BYTES,
  type Allowlist,
  type AllowlistEnvelope,
} from "./types.js";

export interface CachedAllowlist {
  readonly envelope: AllowlistEnvelope;
  /** Where it came from, for diagnostics only. */
  readonly source: string;
  readonly fetchedAt: string;
}

/** Where the last accepted list is kept, so a restart or an outage still has one. */
export interface AllowlistCache {
  read(): Promise<CachedAllowlist | undefined> | CachedAllowlist | undefined;
  write(value: CachedAllowlist): Promise<void> | void;
}

export interface AllowlistView {
  readonly allowlist: Allowlist;
  readonly origin: "remote" | "cache" | "bundled";
  /** The URL it was last fetched from, when it was fetched. */
  readonly source?: string;
  readonly fetchedAt?: string;
  /**
   * `fresh` until `expiresAt`, `stale` for a grace period after it (nothing new
   * is installed from a stale list, but an outage does not break what already
   * runs), then `expired`.
   */
  readonly status: "fresh" | "stale" | "expired";
}

export interface AllowlistAttempt {
  readonly source: string;
  readonly outcome: "ok" | "unreachable" | "invalid" | "stale" | "expired";
  readonly detail?: string;
}

export interface AllowlistRefreshReport {
  readonly updated: boolean;
  readonly attempts: readonly AllowlistAttempt[];
  readonly view: AllowlistView | undefined;
}

export interface AllowlistClient {
  /** Tries the sources in order and keeps the first list that is newer than what is held. */
  refresh(): Promise<AllowlistRefreshReport>;
  /** The best list held now: the newest of the cached one and the bundled one. */
  current(): Promise<AllowlistView | undefined>;
}

export const ALLOWLIST_STALE_GRACE_MS = 7 * 24 * 60 * 60_000;

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RangeError("The response is larger than the allowed size.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Keeps an installation's copy of the allow-list current.
 *
 * Several sources are listed because the list is signed: a copy from a mirror,
 * a gist or an API is exactly as trustworthy as one from the primary, so any of
 * them being reachable is enough. What a source can never do is move the
 * installation backwards. A list older than one already held is a replay, and is
 * ignored even though its signature is valid.
 */
export function createAllowlistClient(options: {
  readonly sources: readonly string[];
  readonly resolveKey: AllowlistKeyResolver;
  readonly cache?: AllowlistCache;
  /** The list shipped with this release. Trusted because it arrived with the code. */
  readonly bundled?: Allowlist;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
}): AllowlistClient {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const graceMs = options.graceMs ?? ALLOWLIST_STALE_GRACE_MS;

  const statusOf = (allowlist: Allowlist): AllowlistView["status"] => {
    const expires = Date.parse(allowlist.expiresAt);
    if (now() < expires) return "fresh";
    return now() < expires + graceMs ? "stale" : "expired";
  };

  async function cached(): Promise<AllowlistView | undefined> {
    const value = await options.cache?.read();
    if (!value) return undefined;
    // Verified again on every read: a cache is a file someone could edit.
    const verified = await verifyAllowlistEnvelope(value.envelope, { resolveKey: options.resolveKey });
    if (!verified.ok) return undefined;
    return {
      allowlist: verified.allowlist,
      origin: "cache",
      source: value.source,
      fetchedAt: value.fetchedAt,
      status: statusOf(verified.allowlist),
    };
  }

  async function current(): Promise<AllowlistView | undefined> {
    const fromCache = await cached();
    const fromBundle: AllowlistView | undefined = options.bundled
      ? { allowlist: options.bundled, origin: "bundled", status: statusOf(options.bundled) }
      : undefined;
    if (fromCache && fromBundle) {
      return fromBundle.allowlist.sequence > fromCache.allowlist.sequence ? fromBundle : fromCache;
    }
    return fromCache ?? fromBundle;
  }

  async function fetchEnvelope(source: string): Promise<unknown> {
    const url = new URL(source);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url))) {
      throw new TypeError("An allow-list source must use https.");
    }
    const response = await send(url, {
      headers: { accept: "application/json" },
      // A redirect is somewhere the operator did not name.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`The source answered ${response.status}.`);
    // The payload is base64 inside JSON, so allow for its overhead.
    return JSON.parse(await readBounded(response, Math.ceil(ALLOWLIST_MAX_BYTES * 1.5)));
  }

  return {
    current,
    async refresh() {
      const attempts: AllowlistAttempt[] = [];
      const held = await current();
      const floor = held?.allowlist.sequence ?? 0;
      for (const source of options.sources) {
        let body: unknown;
        try {
          body = await fetchEnvelope(source);
        } catch (error) {
          attempts.push({
            source,
            outcome: "unreachable",
            detail: error instanceof Error ? error.message : "The source could not be reached.",
          });
          continue;
        }
        const verified = await verifyAllowlistEnvelope(body, { resolveKey: options.resolveKey });
        if (!verified.ok) {
          attempts.push({ source, outcome: "invalid", detail: verified.reason });
          continue;
        }
        if (statusOf(verified.allowlist) === "expired") {
          attempts.push({ source, outcome: "expired", detail: "The allow-list has expired." });
          continue;
        }
        if (verified.allowlist.sequence < floor) {
          attempts.push({
            source,
            outcome: "stale",
            detail: `Sequence ${verified.allowlist.sequence} is older than the ${floor} already held.`,
          });
          continue;
        }
        attempts.push({ source, outcome: "ok" });
        const fetchedAt = new Date(now()).toISOString();
        await options.cache?.write({ envelope: body as AllowlistEnvelope, source, fetchedAt });
        return { updated: true, attempts, view: await current() };
      }
      return { updated: false, attempts, view: held };
    },
  };
}
