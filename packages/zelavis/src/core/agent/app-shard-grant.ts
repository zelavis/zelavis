import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../runtime/effect-boundary.js";
import { resolveTrustedEd25519Key, type ZelavisHostOperationTrustStore } from "../deployment/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../../system-store.js";

const GRANT_CONTEXT = "zelavis-app-shard-grant-v1\n";
const ACCESS_CONTEXT = "zelavis-app-shard-access-v1\n";
const NAMESPACE = "agent.app-shard.v1";

export const APP_SHARD_GRANT_MAX_MS = 30_000;
export const APP_SHARD_ACCESS_MAX_MS = 120_000;

export type AppShardGrantState = "preparing" | "committed" | "released";
type Durability = "crash" | "power";

export interface AppShardGrant {
  readonly keyId: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly incarnation: string;
  readonly shardId: string;
  readonly epoch: number;
  readonly state: AppShardGrantState;
  readonly durability: Durability;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AppShardAccess {
  readonly keyId: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly projectId: string;
  readonly incarnation: string;
  readonly shardId: string;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u001f]/.test(value);
const validState = (value: unknown): value is AppShardGrantState =>
  value === "preparing" || value === "committed" || value === "released";
const validDurability = (value: unknown): value is Durability =>
  value === "crash" || value === "power";
const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

const encode = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const decode = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Window checks shared by signing and verification. */
const boundedWindow = (issuedAt: unknown, expiresAt: unknown, maximum: number) =>
  Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
  (expiresAt as number) > (issuedAt as number) && (expiresAt as number) - (issuedAt as number) <= maximum;

/** The shard key an Agent files a shard under. */
export const appShardKey = (projectId: string, incarnation: string, shardId: string): string =>
  JSON.stringify([projectId, incarnation, shardId]);

const grantPayload = (grant: AppShardGrant) => JSON.stringify([
  grant.keyId, grant.agentId, grant.nodeId, grant.projectId, grant.incarnation, grant.shardId,
  grant.epoch, grant.state, grant.durability, grant.issuedAt, grant.expiresAt,
]);
const accessPayload = (access: AppShardAccess) => JSON.stringify([
  access.keyId, access.agentId, access.nodeId, access.projectId, access.incarnation, access.shardId,
  access.epoch, access.issuedAt, access.expiresAt,
]);

function sign(privateKey: CryptoKey, context: string, body: string): Promise<string> {
  return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    const signature = yield* integrationValue(crypto.subtle.sign("Ed25519", privateKey,
      new TextEncoder().encode(`${context}${body}`)));
    return `${encode(new TextEncoder().encode(body))}.${encode(new Uint8Array(signature))}`;
  }));
}

/** Splits and checks the envelope; the JSON array is the caller's to validate field by field. */
function open(token: string, arity: number, agentId: string, nodeId: string, now: number):
  { readonly body: string; readonly values: readonly unknown[]; readonly signature: Uint8Array<ArrayBuffer> } | undefined {
  if (!validId(agentId) || !validId(nodeId) || !Number.isSafeInteger(now) ||
      typeof token !== "string" || token.length > 8_192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return undefined;
  const [encoded, signed] = token.split(".");
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(decode(encoded!));
    const signature = decode(signed!);
    const values: unknown = JSON.parse(body);
    if (!Array.isArray(values) || values.length !== arity || signature.byteLength !== 64) return undefined;
    return { body, values, signature };
  } catch { return undefined; }
}

function check(trust: ZelavisHostOperationTrustStore, keyId: string, context: string,
  opened: { readonly body: string; readonly signature: Uint8Array<ArrayBuffer> }, now: number): Promise<boolean> {
  return present(Effect.gen(function* (): Effect.fn.Return<boolean, IntegrationFailure> {
    const key = yield* integrationValue(resolveTrustedEd25519Key(trust, keyId, now));
    if (!key) return false;
    return yield* integrationValue(crypto.subtle.verify("Ed25519", key, opened.signature,
      new TextEncoder().encode(`${context}${opened.body}`)));
  }));
}

const identity = (value: { readonly keyId: unknown; readonly agentId: unknown; readonly nodeId: unknown;
  readonly projectId: unknown; readonly incarnation: unknown; readonly shardId: unknown; readonly epoch: unknown }) =>
  validId(value.keyId) && validId(value.agentId) && validId(value.nodeId) && validId(value.projectId) &&
  validId(value.incarnation) && validId(value.shardId) && validEpoch(value.epoch);

/** Platform signs one shard state change for one destination Agent. */
export function signAppShardGrant(privateKey: CryptoKey, grant: AppShardGrant): Promise<string> {
  if (!identity(grant) || !validState(grant.state) || !validDurability(grant.durability) ||
      !boundedWindow(grant.issuedAt, grant.expiresAt, APP_SHARD_GRANT_MAX_MS)) {
    return Promise.reject(new TypeError("App shard grant is invalid or unbounded."));
  }
  return sign(privateKey, GRANT_CONTEXT, grantPayload(grant));
}

export function verifyAppShardGrant(
  trust: ZelavisHostOperationTrustStore,
  token: string,
  agentId: string,
  nodeId: string,
  now = Date.now(),
): Promise<AppShardGrant | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<AppShardGrant | undefined, IntegrationFailure> {
    const opened = open(token, 11, agentId, nodeId, now);
    if (!opened) return undefined;
    const [keyId, audience, destination, projectId, incarnation, shardId, epoch, state, durability, issuedAt, expiresAt] = opened.values;
    if (!identity({ keyId, agentId: audience, nodeId: destination, projectId, incarnation, shardId, epoch }) ||
        audience !== agentId || destination !== nodeId || !validState(state) || !validDurability(durability) ||
        !boundedWindow(issuedAt, expiresAt, APP_SHARD_GRANT_MAX_MS) ||
        (issuedAt as number) > now + 5_000 || (expiresAt as number) <= now) return undefined;
    if (!(yield* integrationValue(check(trust, keyId as string, GRANT_CONTEXT, opened, now)))) return undefined;
    return {
      keyId: keyId as string, agentId: audience as string, nodeId: destination as string,
      projectId: projectId as string, incarnation: incarnation as string, shardId: shardId as string,
      epoch: epoch as number, state, durability, issuedAt: issuedAt as number, expiresAt: expiresAt as number,
    };
  }));
}

/** Platform signs a short bearer for KV calls on one shard at one epoch. */
export function signAppShardAccess(privateKey: CryptoKey, access: AppShardAccess): Promise<string> {
  if (!identity(access) || !boundedWindow(access.issuedAt, access.expiresAt, APP_SHARD_ACCESS_MAX_MS)) {
    return Promise.reject(new TypeError("App shard access is invalid or unbounded."));
  }
  return sign(privateKey, ACCESS_CONTEXT, accessPayload(access));
}

export function verifyAppShardAccess(
  trust: ZelavisHostOperationTrustStore,
  token: string,
  agentId: string,
  nodeId: string,
  now = Date.now(),
): Promise<AppShardAccess | undefined> {
  return present(Effect.gen(function* (): Effect.fn.Return<AppShardAccess | undefined, IntegrationFailure> {
    const opened = open(token, 9, agentId, nodeId, now);
    if (!opened) return undefined;
    const [keyId, audience, destination, projectId, incarnation, shardId, epoch, issuedAt, expiresAt] = opened.values;
    if (!identity({ keyId, agentId: audience, nodeId: destination, projectId, incarnation, shardId, epoch }) ||
        audience !== agentId || destination !== nodeId ||
        !boundedWindow(issuedAt, expiresAt, APP_SHARD_ACCESS_MAX_MS) ||
        (issuedAt as number) > now + 5_000 || (expiresAt as number) <= now) return undefined;
    if (!(yield* integrationValue(check(trust, keyId as string, ACCESS_CONTEXT, opened, now)))) return undefined;
    return {
      keyId: keyId as string, agentId: audience as string, nodeId: destination as string,
      projectId: projectId as string, incarnation: incarnation as string, shardId: shardId as string,
      epoch: epoch as number, issuedAt: issuedAt as number, expiresAt: expiresAt as number,
    };
  }));
}

export interface AppShardHighWater {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly incarnation: string;
  readonly shardId: string;
  readonly epoch: number;
  readonly state: AppShardGrantState;
  readonly durability: Durability;
}

const STATE_ORDER: Readonly<Record<AppShardGrantState, number>> = { preparing: 0, committed: 1, released: 2 };

/** The Agent's durable, forward-only record of the newest grant it has accepted per shard. */
export function createAppShardHighWaterStore(store: ZelavisSystemStore) {
  const parse = (key: string, value: ZelavisSystemStoreValue): AppShardHighWater => {
    const v = value as unknown as Partial<AppShardHighWater> | null;
    if (!v || typeof v !== "object" || Array.isArray(v) || v.schemaVersion !== 1 ||
        !validId(v.projectId) || !validId(v.incarnation) || !validId(v.shardId) ||
        appShardKey(v.projectId, v.incarnation, v.shardId) !== key ||
        !validEpoch(v.epoch) || !validState(v.state) || !validDurability(v.durability)) {
      throw new Error("Malformed app shard high-water record.");
    }
    return v as AppShardHighWater;
  };
  const read = (key: string): Promise<AppShardHighWater | undefined> =>
    present(Effect.gen(function* (): Effect.fn.Return<AppShardHighWater | undefined, IntegrationFailure> {
      if (!validId(key)) return undefined;
      const record = yield* integrationValue(store.get(NAMESPACE, key));
      return record ? parse(key, record.value) : undefined;
    }));
  return {
    read,
    /**
     * Forgets shards released at least `olderThanMillis` ago, so a Project deleted or a shard given back stops costing a
     * record for ever. Safe because a grant lives 30 s and an access token 120 s: nothing signed before the release can
     * still be presented once the retention (far longer than both) has passed. A shard that is not released is never
     * touched. At most `limit` records are removed per call; a record changed meanwhile is left alone.
     */
    prune(input: { readonly now: number; readonly olderThanMillis: number; readonly limit: number }): Promise<number> {
      return present(Effect.gen(function* (): Effect.fn.Return<number, IntegrationFailure> {
        let removed = 0;
        let after: string | undefined;
        for (;;) {
          const page = yield* integrationValue(store.page(NAMESPACE, { limit: 100, ...(after === undefined ? {} : { after }) }));
          for (const record of page.records) {
            if (removed >= input.limit) return removed;
            const held = parse(record.key, record.value);
            if (held.state !== "released" || Date.parse(record.updatedAt) > input.now - input.olderThanMillis) continue;
            if (yield* integrationValue(store.compareAndDelete(NAMESPACE, record.key, record.updatedAt))) removed += 1;
          }
          if (page.next === undefined) return removed;
          after = page.next;
        }
      }));
    },
    /** Forward-only: a higher epoch, or the same epoch with an equal or later state. */
    accept(grant: AppShardGrant): Promise<AppShardHighWater> {
      return present(Effect.gen(function* (): Effect.fn.Return<AppShardHighWater, IntegrationFailure> {
        const key = appShardKey(grant.projectId, grant.incarnation, grant.shardId);
        const next: AppShardHighWater = {
          schemaVersion: 1, projectId: grant.projectId, incarnation: grant.incarnation, shardId: grant.shardId,
          epoch: grant.epoch, state: grant.state, durability: grant.durability,
        };
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const observed = yield* integrationValue(store.get(NAMESPACE, key));
          const previous = observed ? parse(key, observed.value) : undefined;
          if (previous) {
            if (grant.epoch < previous.epoch ||
                (grant.epoch === previous.epoch && STATE_ORDER[grant.state] < STATE_ORDER[previous.state])) {
              throw new Error("App shard grant is stale.");
            }
            if (grant.epoch === previous.epoch && grant.state === previous.state) return previous;
          }
          const value = next as unknown as ZelavisSystemStoreValue;
          const written = observed
            ? yield* integrationValue(store.compareAndSet(NAMESPACE, key, observed.updatedAt, value, observed.value))
            : (yield* integrationValue(store.setIfAbsent(NAMESPACE, key, value))).created;
          if (written) return next;
        }
        throw new Error("App shard grant CAS remained contended.");
      }));
    },
  };
}
