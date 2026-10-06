import { parseAllowlist } from "./parse.js";
import { ALLOWLIST_MAX_BYTES, type Allowlist } from "./types.js";

export interface CachedAllowlist {
  readonly allowlist: Allowlist;
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
 * Sources are tried in order and each is trusted as much as its https origin.
 * What a source can never do is move the installation backwards: a list older
 * than one already held is a replay and is ignored.
 */
export function createAllowlistClient(options: {
  readonly sources: readonly string[];
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
    // Parsed again on every read: a cache is a file someone could edit.
    let allowlist: Allowlist;
    try { allowlist = parseAllowlist(value.allowlist); } catch { return undefined; }
    return {
      allowlist,
      origin: "cache",
      source: value.source,
      fetchedAt: value.fetchedAt,
      status: statusOf(allowlist),
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

  async function fetchList(source: string): Promise<unknown> {
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
    return JSON.parse(await readBounded(response, ALLOWLIST_MAX_BYTES));
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
          body = await fetchList(source);
        } catch (error) {
          attempts.push({
            source,
            outcome: "unreachable",
            detail: error instanceof Error ? error.message : "The source could not be reached.",
          });
          continue;
        }
        let allowlist: Allowlist;
        try {
          allowlist = parseAllowlist(body);
        } catch (error) {
          attempts.push({ source, outcome: "invalid", detail: error instanceof Error ? error.message : "The allow-list could not be read." });
          continue;
        }
        if (statusOf(allowlist) === "expired") {
          attempts.push({ source, outcome: "expired", detail: "The allow-list has expired." });
          continue;
        }
        if (allowlist.sequence < floor) {
          attempts.push({
            source,
            outcome: "stale",
            detail: `Sequence ${allowlist.sequence} is older than the ${floor} already held.`,
          });
          continue;
        }
        attempts.push({ source, outcome: "ok" });
        const fetchedAt = new Date(now()).toISOString();
        await options.cache?.write({ allowlist, source, fetchedAt });
        return { updated: true, attempts, view: await current() };
      }
      return { updated: false, attempts, view: held };
    },
  };
}
