import { Effect, Option, Ref, Scope, Semaphore, Stream } from "effect";
import { isString } from "../../core/json-validation.js";
import { StoreError } from "../errors.js";
import { makeShardHttp, type ShardHttpAnswer } from "./remote-shard-http.js";
import type { KvCondition, KvEngine, KvEntry, KvReader, KvScanOptions, KvWrite } from "../kv.js";

/**
 * The client side of one shard hosted by an Agent (`createRemoteShardHost`): a
 * `KvEngine` whose bytes live on another Node. Everything above the engine —
 * the writer claim, partition revisions, fences, relocation — runs unchanged.
 *
 * The engine holds no authority. It presents the access token its provider
 * gives it; fencing is the Agent's (the shard epoch) and `kv-store`'s (the
 * writer generation inside every `conditionalWrite`).
 */
export interface RemoteShardDestination {
  readonly url: string;
  readonly caPem: string;
}

export interface RemoteShardAccessProvider {
  /** A token valid now. */
  readonly current: Effect.Effect<string, StoreError>;
  /** Called after `unauthorized` or `stale-epoch`: fetch a new token and answer it. */
  readonly renew: Effect.Effect<string, StoreError>;
}

export interface RemoteKvEngineOptions {
  readonly destination: RemoteShardDestination;
  readonly access: RemoteShardAccessProvider;
  /** Milliseconds one request may take; 15_000 unless given. */
  readonly timeoutMillis?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const fail = (op: string, cause: string): StoreError => new StoreError({ op: `remote-kv.${op}`, cause });
const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const decode = (op: string, value: unknown): Effect.Effect<Uint8Array, StoreError> =>
  isString(value) ? Effect.succeed(new Uint8Array(Buffer.from(value, "base64url"))) : Effect.fail(fail(op, "malformed answer: expected bytes"));

const encodeWrite = (write: KvWrite) =>
  write.op === "put"
    ? { op: "put", key: encode(write.key), value: encode(write.value) }
    : { op: "delete", key: encode(write.key) };

const encodeScan = (prefix: Uint8Array, options: KvScanOptions | undefined, snapshot: string | undefined) => ({
  prefix: encode(prefix),
  ...(options?.from === undefined ? {} : { from: encode(options.from) }),
  ...(options?.to === undefined ? {} : { to: encode(options.to) }),
  ...(options?.reverse === undefined ? {} : { reverse: options.reverse }),
  ...(options?.limit === undefined ? {} : { limit: options.limit }),
  ...(snapshot === undefined ? {} : { snapshot }),
});

export const makeRemoteKvEngine = (options: RemoteKvEngineOptions): Effect.Effect<KvEngine, StoreError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => buildEngine(options)),
    (engine) => engine.close,
  );

const buildEngine = (options: RemoteKvEngineOptions): KvEngine => {
  const http = makeShardHttp(options.destination, "/v1/shards/kv", options.timeoutMillis ?? DEFAULT_TIMEOUT_MS);
  const post = http.post;

  const refused = (op: string, answer: ShardHttpAnswer): StoreError =>
    fail(op, `${isString(answer.body.code) ? answer.body.code : `status ${answer.status}`}`);
  const renewable = (answer: ShardHttpAnswer): boolean =>
    answer.status === 401 || (answer.status === 409 && answer.body.code === "stale-epoch");

  /** One request; a refused token is renewed and the same request sent once more (the Agent refused it before touching the engine). */
  const call = (op: string, fields: Record<string, unknown>): Effect.Effect<Record<string, unknown>, StoreError> =>
    Effect.gen(function* () {
      const send = (access: string) => {
        const bodyText = JSON.stringify({ access, op, ...fields });
        if (Buffer.byteLength(bodyText) > MAX_REQUEST_BYTES) return Effect.fail(fail(op, "batch exceeds 16 MiB"));
        return post(op, bodyText);
      };
      let answer = yield* send(yield* options.access.current);
      if (renewable(answer)) answer = yield* send(yield* options.access.renew);
      if (answer.status !== 200) return yield* refused(op, answer);
      return answer.body;
    });

  const entriesOf = (op: string, body: Record<string, unknown>): Effect.Effect<{ readonly entries: KvEntry[]; readonly cursor: string | undefined }, StoreError> =>
    Effect.gen(function* () {
      if (!Array.isArray(body.entries)) return yield* fail(op, "malformed answer: expected entries");
      const entries: KvEntry[] = [];
      for (const pair of body.entries as unknown[]) {
        if (!Array.isArray(pair) || pair.length !== 2) return yield* fail(op, "malformed answer: expected an entry");
        entries.push({ key: yield* decode(op, pair[0]), value: yield* decode(op, pair[1]) });
      }
      if (body.cursor !== undefined && !isString(body.cursor)) return yield* fail(op, "malformed answer: expected a cursor");
      return { entries, cursor: body.cursor };
    });

  const closeQuietly = (op: string, fields: Record<string, unknown>): Effect.Effect<void> =>
    call(op, fields).pipe(Effect.asVoid, Effect.catchCause((cause) => Effect.logWarning(`remote shard ${op} failed`, cause)));

  const get = (snapshot: string | undefined) => (key: Uint8Array): Effect.Effect<Uint8Array | undefined, StoreError> =>
    Effect.gen(function* () {
      const body = yield* call("get", { key: encode(key), ...(snapshot === undefined ? {} : { snapshot }) });
      if (body.value === null) return undefined;
      return yield* decode("get", body.value);
    });

  type Step = { readonly kind: "first" } | { readonly kind: "next"; readonly cursor: string };
  const scan = (snapshot: string | undefined) => (prefix: Uint8Array, scanOptions?: KvScanOptions): Stream.Stream<KvEntry, StoreError> =>
    // The protocol asks for a positive limit; a limit of nothing is answered here without a request.
    scanOptions?.limit === 0 ? Stream.empty : Stream.unwrap(Effect.sync(() => {
      // The cursor the server still holds for this stream; a page that continues replaces it with a new handle.
      let open: string | undefined;
      const pages = Stream.paginate<Step, KvEntry, StoreError>({ kind: "first" }, (step) =>
        Effect.gen(function* () {
          const body = step.kind === "first"
            ? yield* call("scan", encodeScan(prefix, scanOptions, snapshot))
            : yield* Effect.suspend(() => { open = undefined; return call("next", { cursor: step.cursor }); });
          const page = yield* entriesOf("scan", body);
          open = page.cursor;
          return [page.entries, page.cursor === undefined ? Option.none<Step>() : Option.some<Step>({ kind: "next", cursor: page.cursor })] as const;
        }));
      return Stream.ensuring(pages, Effect.suspend(() => open === undefined ? Effect.void : closeQuietly("closeCursor", { cursor: open })));
    }));

  const readerOn = (snapshot: string | undefined): KvReader => ({ get: get(snapshot), scan: scan(snapshot) });

  const write = (writes: ReadonlyArray<KvWrite>): Effect.Effect<void, StoreError> =>
    call("write", { writes: writes.map(encodeWrite) }).pipe(Effect.asVoid);

  const conditionalWrite = (writes: ReadonlyArray<KvWrite>, conditions: ReadonlyArray<KvCondition>): Effect.Effect<boolean, StoreError> =>
    Effect.gen(function* () {
      const body = yield* call("conditionalWrite", {
        writes: writes.map(encodeWrite),
        conditions: conditions.map((condition) => ({ key: encode(condition.key), value: condition.value === undefined ? null : encode(condition.value) })),
      });
      if (typeof body.accepted !== "boolean") return yield* fail("conditionalWrite", "malformed answer: expected accepted");
      return body.accepted;
    });

  const snapshot: Effect.Effect<KvReader, StoreError, Scope.Scope> = Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const body = yield* call("snapshot", {});
        if (!isString(body.snapshot)) return yield* fail("snapshot", "malformed answer: expected a snapshot");
        return body.snapshot;
      }),
      (id) => closeQuietly("closeSnapshot", { snapshot: id }),
    ),
    readerOn,
  );

  return {
    ...readerOn(undefined),
    write,
    conditionalWrite,
    coordination: "remote",
    snapshot,
    close: http.close,
  };
};

/**
 * Renews before expiry: a cached token is reused until less than half its
 * lifetime is left, and concurrent callers share one fetch.
 */
export const remoteShardAccess = (
  fetchAccess: Effect.Effect<{ readonly token: string; readonly expiresAt: number }, StoreError>,
  now: () => number = Date.now,
): Effect.Effect<RemoteShardAccessProvider> =>
  Effect.gen(function* () {
    const cache = yield* Ref.make<{ readonly token: string; readonly refreshAt: number } | undefined>(undefined);
    const gate = yield* Semaphore.make(1);
    const fetchFresh = Effect.gen(function* () {
      const issuedAt = now();
      const fetched = yield* fetchAccess;
      yield* Ref.set(cache, { token: fetched.token, refreshAt: issuedAt + (fetched.expiresAt - issuedAt) / 2 });
      return fetched.token;
    });
    return {
      current: gate.withPermits(1)(Effect.gen(function* () {
        const held = yield* Ref.get(cache);
        if (held !== undefined && now() < held.refreshAt) return held.token;
        return yield* fetchFresh;
      })),
      renew: gate.withPermits(1)(fetchFresh),
    };
  });
