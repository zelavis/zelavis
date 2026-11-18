/**
 * Token buckets for Auth rate limiting.
 *
 * Callers read `rateLimiter.check(ctx, name, { key })` (does not consume)
 * and `rateLimiter.limit(ctx, name, { key })` (consumes) and receive
 * `{ ok, retryAfter }`. A bucket is one row of
 * `limiter_buckets` in the Auth partition, read and written in the caller's
 * transaction, so consuming a token commits with the flow it guards. A bucket
 * starts full at `capacity` (default `rate`) and refills by `rate` tokens per
 * `period`. Keys are stored only as SHA-256 hashes: a bucket names no email
 * address or IP address.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { integration } from "../../core/runtime/effect-boundary.js";
import type { TenantApi } from "../../db/database.js";
import type { TransactionTooLarge } from "../../db/errors.js";
import { invariant } from "./db.js";
import { type AuthSweep, SWEEP_BATCH, defineSweep } from "./sweep.js";
import { defineTable, defineTables } from "./tables.js";
import { type AuthRuntime, type AuthTxBase, NO_REQUEST } from "./tx.js";

export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export interface TokenBucketConfig {
  readonly kind: "token bucket";
  /** Tokens added per `period`. */
  readonly rate: number;
  /** Milliseconds. */
  readonly period: number;
  /** The most tokens a bucket holds, and what it starts with; `rate` unless given. */
  readonly capacity?: number;
}

export type RateLimitResult = { readonly ok: true; readonly retryAfter?: undefined } | { readonly ok: false; readonly retryAfter: number };

export interface RateLimiter<Name extends string> {
  check(tx: AuthTxBase, name: Name, args: { readonly key: string; readonly count?: number }): Effect.Effect<RateLimitResult, TransactionTooLarge>;
  limit(tx: AuthTxBase, name: Name, args: { readonly key: string; readonly count?: number }): Effect.Effect<RateLimitResult, TransactionTooLarge>;
}

export const limiterTables = defineTables("limiter", {
  buckets: defineTable({ bucket: Schema.String, value: Schema.Number, updatedAt: Schema.Number })
    .index("by_bucket", ["bucket"])
    // For the sweep: a bucket idle for a full refill reads the same as no bucket.
    .index("by_updatedAt", ["updatedAt"]),
});

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** SHA-256 of a string, base64url. A digest of in-memory bytes cannot fail; if it does, that is a defect. */
export const sha256Base64Url = (value: string): Effect.Effect<string> =>
  integration(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) => base64Url(new Uint8Array(digest))),
    Effect.orDie,
  );

/** The longest a defined bucket takes to refill from empty: how long a bucket must idle before it may be removed. */
const fullRefillMs = (config: TokenBucketConfig) => Math.ceil(((config.capacity ?? config.rate) * config.period) / config.rate);

// Every bucket the process defines, so the sweep knows how long any of them takes to refill.
const defined = new Map<string, TokenBucketConfig>();

export function defineRateLimits<Name extends string>(module: string, configs: Readonly<Record<Name, TokenBucketConfig>>): RateLimiter<Name> {
  for (const [name, config] of Object.entries<TokenBucketConfig>(configs)) {
    const capacity = config.capacity ?? config.rate;
    if (!(config.rate > 0 && config.period > 0 && capacity > 0)) throw new Error(`Rate limit ${module}:${name} needs a positive rate, period and capacity`);
    defined.set(`${module}:${name}`, config);
  }

  const evaluate = (consume: boolean) => Effect.fn(`auth.limiter.${consume ? "limit" : "check"}`)(function* (
    tx: AuthTxBase,
    name: Name,
    args: { readonly key: string; readonly count?: number },
  ) {
    const config = configs[name];
    const capacity = config.capacity ?? config.rate;
    const count = args.count ?? 1;
    if (!(count > 0 && count <= capacity)) return yield* invariant(`rate limit ${module}:${name} cannot take ${count} of ${capacity}`);
    const bucket = `${module}:${name}:${yield* sha256Base64Url(args.key)}`;
    const row = yield* tx.db.query(limiterTables.buckets).withIndex("by_bucket", (q) => q.eq("bucket", bucket)).unique();
    const elapsed = row === null ? 0 : Math.max(0, tx.now - row.updatedAt);
    const value = row === null ? capacity : Math.min(capacity, row.value + (elapsed * config.rate) / config.period);
    if (value < count) return { ok: false as const, retryAfter: Math.ceil(((count - value) * config.period) / config.rate) };
    if (consume) {
      if (row === null) yield* tx.db.insert(limiterTables.buckets, { bucket, value: value - count, updatedAt: tx.now });
      else yield* tx.db.patch(limiterTables.buckets, row._id, { value: value - count, updatedAt: tx.now });
    }
    return { ok: true as const };
  });

  return { check: evaluate(false), limit: evaluate(true) };
}

/**
 * The sweep that removes idle buckets (Zelavis-own). A bucket whose last use is a full refill ago reads the same
 * as no bucket (it would be full), so removing it changes no answer, and keys named by clients (email addresses,
 * client addresses) cannot grow the table without bound. A bucket is removed once it idled for the longest full
 * refill of any bucket defined here; each removal re-reads the row in its own transaction and keeps one used
 * meanwhile. Same batch rules as every sweep (I8).
 */
export function createLimiterBucketsSweep(tenant: TenantApi, clock: () => number = Date.now): AuthSweep<AuthRuntime> {
  const collection = limiterTables.buckets.collection;
  let cursor = 0;
  return defineSweep({
    name: "limiter.buckets",
    everyMs: 10 * 60_000,
    run: (runtime) => Effect.gen(function* () {
      const idleBefore = clock() - Math.max(0, ...[...defined.values()].map(fullRefillMs));
      const documents = yield* tenant.documents.findMany({
        collection,
        where: [
          { path: "updatedAt", op: "gte", value: cursor },
          { path: "updatedAt", op: "lte", value: idleBefore },
        ],
        orderBy: [{ path: "updatedAt", direction: "asc" }],
        limit: SWEEP_BATCH,
      }).pipe(Effect.orDie);
      let removed = 0;
      for (const document of documents) {
        const deleted = yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
          const row = yield* tx.db.get(limiterTables.buckets, document.id);
          if (row === null || row.updatedAt > idleBefore) return false;
          yield* tx.db.delete(limiterTables.buckets, document.id);
          return true;
        })).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.as(Effect.logWarning(`Auth sweep limiter.buckets skipped ${collection} row ${document.id}.`, cause), false),
          ),
        );
        if (deleted) removed += 1;
      }
      const last = documents[documents.length - 1]?.data.updatedAt;
      cursor = documents.length >= SWEEP_BATCH && typeof last === "number" ? last : 0;
      return removed;
    }),
  });
}
