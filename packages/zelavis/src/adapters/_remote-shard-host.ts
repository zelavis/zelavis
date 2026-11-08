import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Duration, Effect, Exit, Option, Scope, Semaphore, Stream, type Cause } from "effect";
import { integrationValue, present, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";
import {
  appShardKey,
  createAppShardHighWaterStore,
  verifyAppShardAccess,
  verifyAppShardGrant,
  type AppShardAccess,
  type AppShardGrantState,
  type AppShardHighWater,
} from "../core/agent/app-shard-grant.js";
import type { ZelavisSystemStore } from "../system-store.js";
import { scanRange, type KvCondition, type KvEngine, type KvReader, type KvWrite } from "../db/kv.js";
import { makeNodeSqliteEngine } from "../db/engines/node-sqlite.js";
import { openShardReaderOverKv } from "../db/kv-store.js";
import { TENANT_READ_OPS, isPlainJson, isShardTenantRead, jsonSizeWithin, tenantReadsOver, runTenantRead, encodeReadExit, type TenantReadOp } from "../db/tenant-reads.js";
import { makeReadBudget, type ReadLimits } from "../db/read-budget.js";
import { ReadBudgetExceeded } from "../db/errors.js";
import { RoutedBy } from "../db/store.js";
import { GLOBAL_TENANT } from "../db/topology.js";
import { isReservedTenantId } from "../db/naming.js";

const MAX_OPEN_PER_SHARD = 64;
const MAX_PAGE_ENTRIES = 512;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_WRITES = 10_000;
const MAX_CONDITIONS = 64;
const TOKEN_CACHE = 256;

export interface RemoteShardHost {
  applyGrant(token: string): Promise<{ readonly state: AppShardGrantState; readonly epoch: number }>;
  /** One KV request body (already parsed JSON, unknown shape). Never throws: answers a status and a JSON body. */
  kv(body: unknown): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }>;
  reads(body: unknown): Promise<{ readonly status: number; readonly body: Readonly<Record<string, unknown>> }>;
  readsServed(): number;
  close(): Promise<void>;
}

type Answer = { readonly status: number; readonly body: Readonly<Record<string, unknown>> };
const ok = (body: Record<string, unknown> = {}): Answer => ({ status: 200, body });
const refuse = (status: number, code: string): Answer => ({ status, body: { code } });
const invalid = refuse(400, "invalid-request");

interface SnapshotEntry { readonly shardKey: string; readonly reader: KvReader; readonly scope: Scope.Closeable; idleAt: number }
interface Cursor {
  readonly shardKey: string;
  readonly snapshotId: string;
  /** True when the cursor made its own snapshot, which closes with it. */
  readonly ownSnapshot: boolean;
  readonly prefix: Uint8Array;
  readonly from: Uint8Array | undefined;
  readonly to: Uint8Array | undefined;
  readonly reverse: boolean;
  remaining: number;
  lastKey: Uint8Array | undefined;
  idleAt: number;
}
interface OpenShard {
  readonly engine: KvEngine;
  readonly scope: Scope.Closeable;
  readonly cursors: Map<string, Cursor>;
  readonly snapshots: Map<string, SnapshotEntry>;
}

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const decode = (value: unknown, limit = MAX_KEY_BYTES): Uint8Array | undefined => {
  if (typeof value !== "string" || value.length > Math.ceil(limit * 4 / 3) + 4 || !BASE64URL.test(value) || value.length % 4 === 1) return undefined;
  return new Uint8Array(Buffer.from(value, "base64url"));
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Request =
  | { readonly op: "get"; readonly access: string; readonly key: Uint8Array; readonly snapshot: string | undefined }
  | { readonly op: "scan"; readonly access: string; readonly prefix: Uint8Array; readonly from: Uint8Array | undefined;
      readonly to: Uint8Array | undefined; readonly reverse: boolean; readonly limit: number | undefined; readonly snapshot: string | undefined }
  | { readonly op: "next" | "closeCursor"; readonly access: string; readonly cursor: string }
  | { readonly op: "closeSnapshot"; readonly access: string; readonly snapshot: string }
  | { readonly op: "snapshot"; readonly access: string }
  | { readonly op: "write"; readonly access: string; readonly writes: readonly KvWrite[] }
  | { readonly op: "conditionalWrite"; readonly access: string; readonly writes: readonly KvWrite[]; readonly conditions: readonly KvCondition[] };

const handle = (value: unknown): string | undefined | null =>
  value === undefined ? undefined : typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : null;

function parseWrites(value: unknown): KvWrite[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_WRITES) return undefined;
  const writes: KvWrite[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const key = decode(item.key);
    if (key === undefined) return undefined;
    if (item.op === "delete") writes.push({ op: "delete", key });
    else if (item.op === "put") {
      const bytes = decode(item.value, 16 * 1024 * 1024);
      if (bytes === undefined) return undefined;
      writes.push({ op: "put", key, value: bytes });
    } else return undefined;
  }
  return writes;
}

function parse(body: unknown): Request | undefined {
  if (!isRecord(body) || typeof body.access !== "string" || typeof body.op !== "string") return undefined;
  const access = body.access;
  switch (body.op) {
    case "get": {
      const key = decode(body.key), snapshot = handle(body.snapshot);
      return key === undefined || snapshot === null ? undefined : { op: "get", access, key, snapshot };
    }
    case "scan": {
      const prefix = decode(body.prefix);
      const from = body.from === undefined ? undefined : decode(body.from);
      const to = body.to === undefined ? undefined : decode(body.to);
      const snapshot = handle(body.snapshot);
      const limit = body.limit;
      if (prefix === undefined || (body.from !== undefined && from === undefined) || (body.to !== undefined && to === undefined) ||
          snapshot === null || (body.reverse !== undefined && typeof body.reverse !== "boolean") ||
          (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1))) return undefined;
      return { op: "scan", access, prefix, from, to, reverse: body.reverse === true, limit: limit as number | undefined, snapshot };
    }
    case "next": case "closeCursor": {
      const cursor = handle(body.cursor);
      return typeof cursor === "string" ? { op: body.op, access, cursor } : undefined;
    }
    case "closeSnapshot": {
      const snapshot = handle(body.snapshot);
      return typeof snapshot === "string" ? { op: "closeSnapshot", access, snapshot } : undefined;
    }
    case "snapshot": return { op: "snapshot", access };
    case "write": {
      const writes = parseWrites(body.writes);
      return writes === undefined ? undefined : { op: "write", access, writes };
    }
    case "conditionalWrite": {
      const writes = parseWrites(body.writes);
      if (writes === undefined || !Array.isArray(body.conditions) || body.conditions.length > MAX_CONDITIONS) return undefined;
      const conditions: KvCondition[] = [];
      for (const item of body.conditions) {
        if (!isRecord(item)) return undefined;
        const key = decode(item.key);
        const value = item.value === null ? undefined : decode(item.value, 16 * 1024 * 1024);
        if (key === undefined || (item.value !== null && value === undefined)) return undefined;
        conditions.push({ key, value });
      }
      return { op: "conditionalWrite", access, writes, conditions };
    }
    default: return undefined;
  }
}

/** Hosts App shard storage for the Platform's grants: one SQLite engine per committed shard. */
export function createRemoteShardHost(options: {
  readonly dataDirectory: string;
  readonly store: ZelavisSystemStore;
  readonly trust: () => ZelavisHostOperationTrustStore;
  readonly agentId: string;
  readonly nodeId: string;
  readonly now?: () => number;
  readonly sweepEveryMillis?: number;
  readonly idleMillis?: number;
  /** How long a released shard's high-water record is kept; a day unless given (grants live 30 s, tokens 120 s). */
  readonly retainReleasedMillis?: number;
  readonly readsPerShard?: number;
  readonly readsPerAgent?: number;
  readonly readPermitWaitMillis?: number;
  readonly readDeadlineMillis?: number;
  readonly maxReadAnswerBytes?: number;
  /** What one read may spend (see `ReadLimits`); the defaults unless given. Checked before the host starts. */
  readonly readLimits?: Partial<ReadLimits>;
  /** Override the shard engine opener for an embedded host or deterministic tests. */
  readonly openEngine?: typeof makeNodeSqliteEngine;
}): RemoteShardHost {
  for (const value of [options.readsPerShard, options.readsPerAgent, options.readPermitWaitMillis, options.readDeadlineMillis, options.maxReadAnswerBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError("Read limits must be non-negative safe integers.");
  }
  makeReadBudget(options.readLimits);
  const now = options.now ?? Date.now;
  const readerPermits = new Map<string, Semaphore.Semaphore>();
  const readerAdmissions = new Map<string, Semaphore.Semaphore>();
  const pendingGrants = new Map<string, number>();
  const readerAdmissionFor = (key: string) => {
    let permit = readerAdmissions.get(key);
    if (!permit) { permit = Semaphore.makeUnsafe(1); readerAdmissions.set(key, permit); }
    return permit;
  };
  const agentReaders = Semaphore.makeUnsafe(options.readsPerAgent ?? 16);
  let served = 0;
  const readPermitFor = (key: string) => {
    let permit = readerPermits.get(key);
    if (!permit) { permit = Semaphore.makeUnsafe(options.readsPerShard ?? 4); readerPermits.set(key, permit); }
    return permit;
  };
  const root = join(resolve(options.dataDirectory), "shards");
  const highWater = createAppShardHighWaterStore(options.store);
  const hostScope = Scope.makeUnsafe();
  const open = new Map<string, OpenShard>();
  const permits = new Map<string, Semaphore.Semaphore>();
  const tokens = new Map<string, AppShardAccess>();
  const idleMillis = options.idleMillis ?? 30_000;
  const permitFor = (key: string) => {
    let permit = permits.get(key);
    if (!permit) { permit = Semaphore.makeUnsafe(1); permits.set(key, permit); }
    return permit;
  };
  const directoryOf = (key: string) => join(root, createHash("sha256").update(key).digest("hex"));
  const newId = () => randomBytes(16).toString("hex");

  const closeShard = (key: string): Effect.Effect<void> => Effect.gen(function* () {
    const shard = open.get(key);
    if (!shard) return;
    open.delete(key);
    for (const entry of shard.snapshots.values()) yield* Scope.close(entry.scope, Exit.void);
    for (const cursor of shard.cursors.values()) yield* closeCursor(shard, cursor);
    yield* Scope.close(shard.scope, Exit.void);
  });
  const closeCursor = (shard: OpenShard, cursor: Cursor): Effect.Effect<void> => Effect.gen(function* () {
    for (const [id, held] of shard.cursors) if (held === cursor) shard.cursors.delete(id);
    if (cursor.ownSnapshot) {
      const entry = shard.snapshots.get(cursor.snapshotId);
      shard.snapshots.delete(cursor.snapshotId);
      if (entry) yield* Scope.close(entry.scope, Exit.void);
    }
  });

  /** The shard permit is held by the caller. */
  const openUnderPermit = (key: string, record: Pick<AppShardHighWater, "shardId" | "durability">): Effect.Effect<OpenShard, IntegrationFailure> =>
    Effect.gen(function* () {
      const existing = open.get(key);
      if (existing) return existing;
      const directory = directoryOf(key);
      yield* integrationValue(mkdir(directory, { recursive: true, mode: 0o700 }));
      const scope = yield* Scope.make();
      const engine = yield* integrationValue(present(Scope.provide(scope)(
        (options.openEngine ?? makeNodeSqliteEngine)(record.shardId, directory, record.durability))));
      const shard: OpenShard = { engine, scope, cursors: new Map(), snapshots: new Map() };
      open.set(key, shard);
      return shard;
    });

  const applyGrant: RemoteShardHost["applyGrant"] = (token) => present(Effect.gen(function* () {
    const grant = yield* integrationValue(verifyAppShardGrant(options.trust(), token, options.agentId, options.nodeId, now()));
    if (!grant) throw new Error("App shard grant is invalid or expired.");
    const key = appShardKey(grant.projectId, grant.incarnation, grant.shardId);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => { pendingGrants.set(key, (pendingGrants.get(key) ?? 0) + 1); }),
      () => readerAdmissionFor(key).withPermit(readPermitFor(key).withPermits(options.readsPerShard ?? 4)(permitFor(key).withPermit(Effect.gen(function* () {
        const stored = yield* integrationValue(highWater.accept(grant));
        if (stored.state === "preparing") yield* openUnderPermit(key, stored);
        else if (stored.state === "released") {
          yield* closeShard(key);
          yield* integrationValue(rm(directoryOf(key), { recursive: true, force: true }));
        }
        return { state: stored.state, epoch: stored.epoch };
      })))),
      () => Effect.sync(() => {
        const remaining = pendingGrants.get(key)! - 1;
        if (remaining === 0) pendingGrants.delete(key);
        else pendingGrants.set(key, remaining);
      }),
    );
  }));

  const verifyAccess = (token: string): Effect.Effect<AppShardAccess | undefined, IntegrationFailure> => Effect.gen(function* () {
    const cached = tokens.get(token);
    if (cached) return cached.expiresAt > now() ? cached : undefined;
    const access = yield* integrationValue(verifyAppShardAccess(options.trust(), token, options.agentId, options.nodeId, now()));
    if (!access) return undefined;
    if (tokens.size >= TOKEN_CACHE) tokens.delete(tokens.keys().next().value as string);
    tokens.set(token, access);
    return access;
  });

  /** Invariant 2: served only for a committed shard at exactly the token's epoch. */
  const authorize = (access: AppShardAccess, key: string): Effect.Effect<AppShardHighWater | Answer, IntegrationFailure> => Effect.gen(function* () {
    const stored = yield* integrationValue(highWater.read(key));
    if (!stored) return refuse(409, "not-committed");
    if (access.epoch < stored.epoch) return refuse(409, "stale-epoch");
    if (stored.state !== "committed" || access.epoch !== stored.epoch) return refuse(409, "not-committed");
    return stored;
  });

  const page = (shard: OpenShard, reader: KvReader, cursor: Cursor): Effect.Effect<Answer, IntegrationFailure> => Effect.gen(function* () {
    const limit = Math.min(MAX_PAGE_ENTRIES, cursor.remaining);
    const range = scanRange(cursor.prefix, { from: cursor.from, to: cursor.to });
    const entries: [string, string][] = [];
    let bytes = 0, lastKey: Uint8Array | undefined, truncated = false;
    if (!range.empty && limit > 0) {
      const collected = yield* integrationValue(present(Stream.runCollect(reader.scan(cursor.prefix, {
        from: cursor.from, to: cursor.to, reverse: cursor.reverse, limit }))));
      for (const entry of collected) {
        bytes += entry.key.byteLength + entry.value.byteLength;
        if (entries.length > 0 && bytes > MAX_PAGE_BYTES) { truncated = true; break; }
        entries.push([encode(entry.key), encode(entry.value)]);
        lastKey = entry.key;
      }
      cursor.remaining -= entries.length;
      const more = truncated || (entries.length === limit && cursor.remaining > 0);
      if (more && lastKey) {
        // The next page starts just after the last key returned, in scan order.
        const resumed = cursor.reverse
          ? { from: cursor.from, to: lastKey }
          : { from: new Uint8Array([...lastKey, 0]), to: cursor.to };
        const continued: Cursor = { ...cursor, ...resumed, lastKey, idleAt: now() };
        const id = newId();
        shard.cursors.set(id, continued);
        return ok({ entries, cursor: id });
      }
    }
    return ok({ entries });
  });

  const run = (request: Request): Effect.Effect<Answer, IntegrationFailure> => Effect.gen(function* () {
    const access = yield* verifyAccess(request.access);
    if (!access) return refuse(401, "unauthorized");
    const key = appShardKey(access.projectId, access.incarnation, access.shardId);
    const writing = request.op === "write" || request.op === "conditionalWrite";
    const serve = (): Effect.Effect<Answer, IntegrationFailure> => Effect.gen(function* () {
      const checked = yield* authorize(access, key);
      if ("status" in checked) return checked;
      const shard = open.get(key) ?? (writing
        ? yield* openUnderPermit(key, checked)
        : yield* permitFor(key).withPermit(openUnderPermit(key, checked)));
      const idle = now();
      const reader = (id: string | undefined): KvReader | undefined => {
        if (id === undefined) return shard.engine;
        const entry = shard.snapshots.get(id);
        if (!entry || entry.shardKey !== key) return undefined;
        entry.idleAt = idle;
        return entry.reader;
      };
      switch (request.op) {
        case "get": {
          const from = reader(request.snapshot);
          if (!from) return refuse(404, "unknown-cursor");
          const value = yield* integrationValue(present(from.get(request.key)));
          return ok({ value: value === undefined ? null : encode(value) });
        }
        case "scan": {
          if (shard.cursors.size + shard.snapshots.size >= MAX_OPEN_PER_SHARD) return refuse(503, "busy");
          let snapshotId = request.snapshot, own = false, source = reader(snapshotId);
          if (!source) return refuse(404, "unknown-cursor");
          if (snapshotId === undefined) {
            const scope = yield* Scope.make();
            source = yield* integrationValue(present(Scope.provide(scope)(shard.engine.snapshot)));
            snapshotId = newId(); own = true;
            shard.snapshots.set(snapshotId, { shardKey: key, reader: source, scope, idleAt: idle });
          }
          const cursor: Cursor = { shardKey: key, snapshotId, ownSnapshot: own, prefix: request.prefix, from: request.from, to: request.to,
            reverse: request.reverse, remaining: request.limit ?? Number.MAX_SAFE_INTEGER, lastKey: undefined, idleAt: idle };
          const answer = yield* page(shard, source, cursor);
          if (own && answer.body.cursor === undefined) yield* closeCursor(shard, cursor);
          return answer;
        }
        case "next": {
          const cursor = shard.cursors.get(request.cursor);
          if (!cursor || cursor.shardKey !== key) return refuse(404, "unknown-cursor");
          const source = reader(cursor.snapshotId);
          shard.cursors.delete(request.cursor);
          if (!source) return refuse(404, "unknown-cursor");
          const answer = yield* page(shard, source, cursor);
          if (cursor.ownSnapshot && answer.body.cursor === undefined) yield* closeCursor(shard, cursor);
          return answer;
        }
        case "closeCursor": {
          const cursor = shard.cursors.get(request.cursor);
          if (!cursor || cursor.shardKey !== key) return refuse(404, "unknown-cursor");
          yield* closeCursor(shard, cursor);
          return ok();
        }
        case "snapshot": {
          if (shard.cursors.size + shard.snapshots.size >= MAX_OPEN_PER_SHARD) return refuse(503, "busy");
          const scope = yield* Scope.make();
          const taken = yield* integrationValue(present(Scope.provide(scope)(shard.engine.snapshot)));
          const id = newId();
          shard.snapshots.set(id, { shardKey: key, reader: taken, scope, idleAt: idle });
          return ok({ snapshot: id });
        }
        case "closeSnapshot": {
          const entry = shard.snapshots.get(request.snapshot);
          if (!entry || entry.shardKey !== key) return refuse(404, "unknown-cursor");
          shard.snapshots.delete(request.snapshot);
          yield* Scope.close(entry.scope, Exit.void);
          return ok();
        }
        case "write": {
          yield* integrationValue(present(shard.engine.write(request.writes)));
          return ok();
        }
        case "conditionalWrite": {
          if (!shard.engine.conditionalWrite) return refuse(500, "storage-failed");
          const accepted = yield* integrationValue(present(shard.engine.conditionalWrite(request.writes, request.conditions)));
          return ok({ accepted });
        }
      }
    });
    return writing ? yield* permitFor(key).withPermit(serve()) : yield* serve();
  });

  const kv: RemoteShardHost["kv"] = (body) => {
    const request = parse(body);
    if (!request) return Promise.resolve(invalid);
    return present(run(request).pipe(
      Effect.exit,
      Effect.map((exit) => Exit.isSuccess(exit) ? exit.value : refuse(500, "storage-failed")),
    ));
  };

  const refusedByBudget = (cause: Cause.Cause<unknown>) =>
    cause.reasons.some((reason) => reason._tag === "Die" && reason.defect instanceof ReadBudgetExceeded);
  const reads: RemoteShardHost["reads"] = (body) => {
    if (!isRecord(body) || body.protocol !== 1 || typeof body.access !== "string" ||
        typeof body.partition !== "string" || body.partition.length < 1 || body.partition.length > 512 ||
        isReservedTenantId(body.partition) || !Number.isSafeInteger(body.routedBy) || (body.routedBy as number) < 0 ||
        typeof body.op !== "string" || !TENANT_READ_OPS.some((op) => op === body.op) || !Object.hasOwn(body, "input") ||
        !isPlainJson(body.input).ok) return Promise.resolve(invalid);
    const op = body.op as TenantReadOp;
    if (!isShardTenantRead(op, body.input)) return Promise.resolve(invalid);
    const request = { access: body.access, partition: body.partition, routedBy: body.routedBy as number, op, input: body.input as import("../db/json.js").Json | null };
    const runRead = Effect.gen(function* () {
      const access = yield* verifyAccess(request.access);
      if (!access) return refuse(401, "unauthorized");
      const key = appShardKey(access.projectId, access.incarnation, access.shardId);
      const checked = yield* authorize(access, key);
      if ("status" in checked) return checked;
      if (pendingGrants.has(key)) return refuse(503, "busy");
      const wait = Duration.millis(options.readPermitWaitMillis ?? 1000);
      return yield* Effect.scoped(Effect.gen(function* () {
        const acquire = (permit: Semaphore.Semaphore) => Effect.acquireRelease(
          permit.take(1).pipe(Effect.timeoutOption(wait)),
          (taken) => Option.isSome(taken) ? Effect.asVoid(permit.release(1)) : Effect.void,
        );
        if (Option.isNone(yield* acquire(agentReaders))) return refuse(503, "busy");
        if (pendingGrants.has(key)) return refuse(503, "busy");
        // Hold admission only while taking a read slot. A grant waiting at the turnstile stops new readers,
        // then drains the current slots without starving under sustained read traffic.
        const admitted = yield* readerAdmissionFor(key).withPermit(Effect.suspend(() =>
          pendingGrants.has(key) ? Effect.succeed(Option.none<number>()) : acquire(readPermitFor(key))
        )).pipe(Effect.timeoutOption(wait));
        if (Option.isNone(admitted) || Option.isNone(admitted.value)) return refuse(503, "busy");
        const opened = yield* permitFor(key).withPermit(Effect.gen(function* () {
          if (access.expiresAt <= now()) return refuse(401, "unauthorized");
          const current = yield* authorize(access, key);
          if ("status" in current) return current;
          return { shard: yield* openUnderPermit(key, current) };
        }));
        if ("status" in opened) return opened;
        const shard = opened.shard;
        // Reads here are bounded and every engine that cannot say so is refused, never read without a limit.
        if (shard.engine.bounded === undefined) return refuse(500, "unbounded-engine");
        if (options.readDeadlineMillis === 0) return refuse(504, "deadline");
        // One budget and one reader per read: the reader holds no state a later read could use, and the budget is this read's alone.
        const budget = makeReadBudget(options.readLimits);
        const read = Effect.gen(function* () {
          const opening = yield* Effect.exit(openShardReaderOverKv(access.shardId, shard.engine, { budget }));
          // Running out of budget while opening is the read's refusal like any other; any other failure to open is the shard's.
          if (Exit.isFailure(opening)) return refusedByBudget(opening.cause) ? opening : yield* Effect.failCause(opening.cause);
          const reader = opening.value;
          return yield* runTenantRead(tenantReadsOver(reader.partition(request.partition), reader.partition(GLOBAL_TENANT), request.partition), request.op, request.input).pipe(
            Effect.provideService(RoutedBy, request.routedBy), Effect.exit);
        });
        const answer = yield* read.pipe(Effect.timeoutOption(Duration.millis(options.readDeadlineMillis ?? 10_000)));
        if (Option.isNone(answer)) return refuse(504, "deadline");
        const result = encodeReadExit(answer.value);
        // Sized exactly before anything is serialized: an answer over the limit is never built as one string.
        if (jsonSizeWithin(result, options.maxReadAnswerBytes ?? 32 * 1024 * 1024) === undefined) return refuse(413, "answer-too-large");
        served += 1;
        return ok(result);
      }));
    });
    return present(runRead.pipe(Effect.exit, Effect.map((exit) => Exit.isSuccess(exit) ? exit.value : refuse(500, "storage-failed"))));
  };

  const retainReleased = options.retainReleasedMillis ?? 24 * 3_600_000;
  const PRUNE_BATCH = 100;
  // A scan of every record: done about hourly, not on every sweep.
  const pruneEvery = Math.min(3_600_000, retainReleased);
  let lastPruned = now();
  const pruneReleased = Effect.gen(function* () {
    const removed = yield* integrationValue(highWater.prune({ now: now(), olderThanMillis: retainReleased, limit: PRUNE_BATCH }));
    if (removed > 0) yield* Effect.logInfo(`Forgot ${removed} released App shard record(s).`);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Pruning released App shard records failed", cause)));
  const sweep = Effect.gen(function* () {
    if (now() - lastPruned >= pruneEvery) {
      lastPruned = now();
      yield* pruneReleased;
    }
    const cutoff = now() - idleMillis;
    for (const shard of open.values()) {
      for (const cursor of [...shard.cursors.values()]) if (cursor.idleAt < cutoff) yield* closeCursor(shard, cursor);
      for (const [id, entry] of [...shard.snapshots]) {
        if (entry.idleAt >= cutoff) continue;
        shard.snapshots.delete(id);
        yield* Scope.close(entry.scope, Exit.void);
      }
    }
  });
  Effect.runFork(Effect.forkIn(Effect.forever(Effect.gen(function* () {
    yield* Effect.sleep(options.sweepEveryMillis ?? 10_000);
    yield* sweep;
  })), hostScope));

  return {
    applyGrant,
    kv,
    reads,
    readsServed: () => served,
    close: () => present(Effect.gen(function* () {
      for (const key of [...open.keys()]) yield* readerAdmissionFor(key).withPermit(readPermitFor(key).withPermits(options.readsPerShard ?? 4)(closeShard(key)));
      yield* Scope.close(hostScope, Exit.void);
    })),
  };
}
