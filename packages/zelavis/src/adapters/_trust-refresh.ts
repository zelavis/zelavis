import { readFile } from "node:fs/promises";
import { Data, Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import { createZelavisClient } from "../sdk/fetch.js";
import { parseHostOperationTrustStore } from "./_agent-host-operations.js";
import { writeFileAtomically } from "./_atomic-file.js";
import { createPinnedFetch } from "./_pinned-fetch.js";

/**
 * A joined machine's way to follow the Platform's key rotation.
 *
 * The Platform signs with a key for a year and rotates it 30 days before it expires, keeping
 * the old one trusted until then. A worker received the keys when it enrolled, so without
 * this it would stop accepting the Platform on the day the old key expired. It asks again
 * over the same pinned connection it enrolled on: the pin (a certificate fingerprint or a
 * CA the operator named) is what authenticates the answer, exactly as at enrollment, and
 * the answer is public keys only, so nothing secret travels either way.
 *
 * The answer is checked like any trust file, and refused when it holds no key valid now,
 * because a set that trusts nothing would lock the machine out of its own Platform.
 */

export class TrustRefreshError extends Data.TaggedError("TrustRefreshError")<{ readonly message: string; readonly cause?: unknown }> {}

/** How this machine authenticates the Platform; recorded when it joined. */
export interface PlatformPin {
  /** The Platform's https origin plus its dashboard root, for example `https://panel.example.com/zelavis`. */
  readonly url: string;
  readonly fingerprint?: string;
  /** Path to a PEM file of the CA to trust instead of the public roots. */
  readonly caFile?: string;
}

/** How often a running Agent asks. The overlap is 30 days, so a day is generous. */
export const TRUST_REFRESH_INTERVAL_MS = 24 * 60 * 60_000;

const hasValidKey = (trust: ZelavisHostOperationTrustStore, at: number) =>
  trust.keys.some((key) => Date.parse(key.notBefore) <= at && at <= Date.parse(key.notAfter) && !trust.revokedKeyIds?.includes(key.keyId));

export const fetchPlatformTrust = (platform: PlatformPin, now: () => number = Date.now) =>
  Effect.gen(function* () {
    const base = new URL(platform.url);
    const caPem = platform.caFile === undefined ? undefined : yield* integration(() => readFile(platform.caFile!, "utf8"));
    const client = createZelavisClient({
      baseUrl: base.origin,
      rootPath: base.pathname === "/" ? "/zelavis" : base.pathname.replace(/\/+$/, ""),
      fetch: createPinnedFetch({
        ...(platform.fingerprint === undefined ? {} : { fingerprint: platform.fingerprint }),
        ...(caPem === undefined ? {} : { caPem }),
      }),
    });
    const answer = yield* integration(() => client.nodes.trust());
    const checked = parseHostOperationTrustStore(answer);
    if (checked.trust === undefined) return yield* new TrustRefreshError({ message: "The Platform sent a trust store that is not valid." });
    if (!hasValidKey(checked.trust, now())) return yield* new TrustRefreshError({ message: "The Platform sent no key that is valid now; keeping the current keys." });
    return checked.trust;
  }).pipe(
    Effect.mapError((error) => error instanceof TrustRefreshError ? error
      : new TrustRefreshError({ message: `Could not refresh the Platform's keys: ${error instanceof Error ? error.message : String(error)}`, cause: error })),
  );

const sameKeys = (left: ZelavisHostOperationTrustStore, right: ZelavisHostOperationTrustStore) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Fetches the keys and replaces `trustFile` when they differ. Returns the keys now in force. */
export const refreshTrustFile = (input: { readonly platform: PlatformPin; readonly trustFile: string; readonly now?: () => number }) =>
  Effect.gen(function* () {
    const fresh = yield* fetchPlatformTrust(input.platform, input.now);
    const current = yield* integration(() => readFile(input.trustFile, "utf8")).pipe(
      Effect.map((text) => parseHostOperationTrustStore(JSON.parse(text)).trust),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (current !== undefined && sameKeys(current, fresh)) return { trust: current, changed: false as const };
    yield* writeFileAtomically(input.trustFile, `${JSON.stringify(fresh, null, 2)}\n`, 0o644).pipe(
      Effect.mapError((error) => new TrustRefreshError({ message: "The refreshed keys could not be written.", cause: error })),
    );
    return { trust: fresh, changed: true as const };
  });
