import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  State,
  STATE_STORE_VERSION,
  StateStoreError,
  encodeState,
  reviveStateRecursive,
} from "alchemy/State";
import type { PersistedState, StateService } from "alchemy/State";

/**
 * Alchemy's provisioning state, kept in a Zelavis conditional store.
 *
 * Authority and invariants:
 * - Provisioning state only. It never holds Project, placement or data
 *   authority; Fabric owns those.
 * - One document per (stack, stage), so every write is a single-key
 *   compare-and-set, the only atomic primitive the System Store offers. A
 *   write is accepted only if the document is exactly what the writer read.
 * - `acquire` bumps an epoch and records the owner. The returned service is
 *   bound to that owner and epoch and fails with `StateFenced` as soon as the
 *   document names another. Alchemy writes a `creating`, `updating` or
 *   `deleting` row before it calls a cloud, so a superseded worker is stopped
 *   at that write, before it can create or delete anything.
 * - Secrets (`Redacted` values) are sealed before they are stored. The codec
 *   is required: a secret only appears after the cloud has acted (a generated
 *   deploy key, say), so a missing codec must be impossible to run with, not a
 *   failure discovered after a machine exists.
 * - Growth is bounded: a compare-and-set conflict is retried a fixed number of
 *   times, then reported.
 */

export const PROVISIONING_STATE_NAMESPACE = "cloud.provisioning-state.v1";
const MAX_ID_LENGTH = 256;
const MAX_ATTEMPTS = 16;
const REDACTED = "__redacted__";
const SEALED = "__sealed__";

type StoreValue =
  | null
  | boolean
  | number
  | string
  | readonly StoreValue[]
  | { readonly [key: string]: StoreValue };

interface StoreRecord {
  readonly value: StoreValue;
  readonly updatedAt: string;
}

type Maybe<T> = T | Promise<T>;

/** The slice of the Zelavis System Store this state needs. */
export interface ConditionalStore {
  get(namespace: string, key: string): Maybe<StoreRecord | undefined>;
  setIfAbsent(
    namespace: string,
    key: string,
    value: StoreValue,
  ): Maybe<{ created: boolean; record: StoreRecord }>;
  compareAndSet(
    namespace: string,
    key: string,
    expectedUpdatedAt: string,
    value: StoreValue,
    expectedValue?: StoreValue,
  ): Maybe<StoreRecord | undefined>;
  compareAndDelete(namespace: string, key: string, expectedUpdatedAt: string): Maybe<boolean>;
}

export interface SecretCodec {
  /** `aad` binds the ciphertext to its document so it cannot be moved. */
  seal(plaintext: string, aad: string): string;
  open(sealed: string, aad: string): string;
}

export class StateFenced extends Data.TaggedError("StateFenced")<{
  readonly stack: string;
  readonly stage: string;
  readonly epoch: number;
  readonly currentOwner: string | undefined;
  readonly currentEpoch: number | undefined;
}> {}

export class StateContention extends Data.TaggedError("StateContention")<{
  readonly stack: string;
  readonly stage: string;
  readonly attempts: number;
}> {}

export class StateCorrupt extends Data.TaggedError("StateCorrupt")<{
  readonly stack: string;
  readonly stage: string;
  readonly reason: string;
}> {}

export class StateStoreFailure extends Data.TaggedError("StateStoreFailure")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export type ProvisioningStateError =
  | StateFenced
  | StateContention
  | StateCorrupt
  | StateStoreFailure;

interface StateDocument {
  readonly v: 1;
  readonly stack: string;
  readonly stage: string;
  readonly owner: string;
  readonly epoch: number;
  readonly resources: { readonly [fqn: string]: StoreValue };
  readonly outputs: StoreValue;
}

export interface AcquireInput {
  readonly stack: string;
  readonly stage: string;
  /** Identifies this worker or apply session; recorded, never trusted for access. */
  readonly owner: string;
}

export interface ProvisioningStateOptions {
  readonly store: ConditionalStore;
  readonly secrets: SecretCodec;
}

export interface FencedState {
  readonly stack: string;
  readonly stage: string;
  readonly owner: string;
  readonly epoch: number;
  /** The Alchemy state layer for this stack and stage. */
  readonly layer: Layer.Layer<State>;
  /** The same service, for callers that use it directly. */
  readonly service: StateService;
}

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH &&
  !/[\u0000-\u001f/]/.test(value);

const documentKey = (stack: string, stage: string): string => `${stack}/${stage}`;

const jsonSafe = (value: unknown): StoreValue =>
  value === undefined ? null : (JSON.parse(JSON.stringify(value)) as StoreValue);

const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isDocument = (value: unknown): value is StateDocument =>
  isObject(value) &&
  value.v === 1 &&
  typeof value.stack === "string" &&
  typeof value.stage === "string" &&
  typeof value.owner === "string" &&
  typeof value.epoch === "number" &&
  Number.isSafeInteger(value.epoch) &&
  value.epoch >= 1 &&
  isObject(value.resources);

/** Replace every redacted value with its sealed form. */
function sealTree(node: unknown, codec: SecretCodec, aad: string): unknown {
  if (Array.isArray(node)) return node.map((item) => sealTree(item, codec, aad));
  if (!isObject(node)) return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === REDACTED) {
    return { [SEALED]: codec.seal(JSON.stringify(node[REDACTED] ?? null), aad) };
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = sealTree(value, codec, aad);
  }
  return result;
}

/** Inverse of `sealTree`, back to the redacted form Alchemy revives. */
function openTree(node: unknown, codec: SecretCodec, aad: string): unknown {
  if (Array.isArray(node)) return node.map((item) => openTree(item, codec, aad));
  if (!isObject(node)) return node;
  const keys = Object.keys(node);
  if (keys.length === 1 && keys[0] === SEALED) {
    if (typeof node[SEALED] !== "string") throw new Error("sealed secret is malformed");
    return { [REDACTED]: JSON.parse(codec.open(node[SEALED], aad)) as unknown };
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) result[key] = openTree(value, codec, aad);
  return result;
}

/**
 * AES-256-GCM sealing for secrets at rest. The caller supplies the key; where
 * it comes from (the Platform's key management) is not decided here.
 */
export function aesGcmSecretCodec(key: Uint8Array): SecretCodec {
  if (key.byteLength !== 32) throw new TypeError("The secret key must be exactly 32 bytes.");
  return {
    seal(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
    },
    open(sealed, aad) {
      const [version, iv, tag, body] = sealed.split(".");
      if (version !== "v1" || iv === undefined || tag === undefined || body === undefined) {
        throw new Error("unrecognized sealed secret");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

export function createProvisioningState(options: ProvisioningStateOptions) {
  const { store, secrets } = options;
  if (typeof secrets?.seal !== "function" || typeof secrets?.open !== "function") {
    throw new TypeError("Provisioning state requires a secret codec: secrets are never stored unsealed.");
  }

  const call = <T>(operation: string, thunk: () => Maybe<T>) =>
    Effect.tryPromise({
      try: () => Promise.resolve(thunk()),
      catch: (cause) => new StateStoreFailure({ operation, cause }),
    });

  const readDocument = Effect.fn("ProvisioningState.read")(function* (stack: string, stage: string) {
    const record = yield* call("get", () => store.get(PROVISIONING_STATE_NAMESPACE, documentKey(stack, stage)));
    if (record === undefined) return undefined;
    const stored: unknown = record.value;
    if (!isDocument(stored) || stored.stack !== stack || stored.stage !== stage) {
      return yield* new StateCorrupt({ stack, stage, reason: "stored document has an unexpected shape or identity" });
    }
    return { document: stored, updatedAt: record.updatedAt };
  });

  /** Take ownership: a new epoch, which fences every earlier owner. */
  const acquire = Effect.fn("ProvisioningState.acquire")(function* (input: AcquireInput) {
    if (!validId(input.stack) || !validId(input.stage) || !validId(input.owner)) {
      return yield* new StateCorrupt({
        stack: String(input.stack),
        stage: String(input.stage),
        reason: "stack, stage and owner must be non-empty ids without '/'",
      });
    }
    const { stack, stage, owner } = input;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const current = yield* readDocument(stack, stage);
      if (current === undefined) {
        const fresh: StateDocument = { v: 1, stack, stage, owner, epoch: 1, resources: {}, outputs: null };
        const created = yield* call("setIfAbsent", () =>
          store.setIfAbsent(PROVISIONING_STATE_NAMESPACE, documentKey(stack, stage), jsonSafe(fresh)),
        );
        if (created.created) return makeFenced(input, fresh.epoch);
        continue;
      }
      const next: StateDocument = { ...current.document, owner, epoch: current.document.epoch + 1 };
      const written = yield* call("compareAndSet", () =>
        store.compareAndSet(
          PROVISIONING_STATE_NAMESPACE,
          documentKey(stack, stage),
          current.updatedAt,
          jsonSafe(next),
          jsonSafe(current.document),
        ),
      );
      if (written !== undefined) return makeFenced(input, next.epoch);
    }
    return yield* new StateContention({ stack, stage, attempts: MAX_ATTEMPTS });
  });

  function makeFenced(input: AcquireInput, epoch: number): FencedState {
    const { stack, stage, owner } = input;
    const aad = documentKey(stack, stage);

    const requireCurrent = (document: StateDocument) =>
      document.owner === owner && document.epoch === epoch
        ? Effect.succeed(document)
        : Effect.fail(
            new StateFenced({ stack, stage, epoch, currentOwner: document.owner, currentEpoch: document.epoch }),
          );

    /** Set once this owner has deleted the stack itself; reads then see it empty. */
    let deletedByThisOwner = false;

    const load = (forWrite = false) =>
      Effect.gen(function* () {
        const current = yield* readDocument(stack, stage);
        if (current === undefined) {
          if (deletedByThisOwner && !forWrite) {
            const empty: StateDocument = { v: 1, stack, stage, owner, epoch, resources: {}, outputs: null };
            return { document: empty, updatedAt: "" };
          }
          return yield* new StateFenced({ stack, stage, epoch, currentOwner: undefined, currentEpoch: undefined });
        }
        yield* requireCurrent(current.document);
        return current;
      });

    /** Read-modify-write under compare-and-set, rejecting once fenced. */
    const mutate = <A>(
      change: (document: StateDocument) => { readonly next: StateDocument; readonly result: A },
    ) =>
      Effect.gen(function* () {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const current = yield* load(true);
        const { next, result } = change(current.document);
        const written = yield* call("compareAndSet", () =>
          store.compareAndSet(
            PROVISIONING_STATE_NAMESPACE,
            documentKey(stack, stage),
            current.updatedAt,
            jsonSafe(next),
            jsonSafe(current.document),
          ),
        );
        if (written !== undefined) return result;
        yield* Effect.sleep(`${attempt} millis`);
      }
      return yield* new StateContention({ stack, stage, attempts: MAX_ATTEMPTS });
      });

    const sealValue = (value: unknown) =>
      Effect.try({
        try: () => jsonSafe(sealTree(encodeState(value), secrets, aad)),
        catch: (cause) => new StateStoreFailure({ operation: "encode", cause }),
      });

    const openValue = (value: StoreValue) =>
      Effect.try({
        try: () => reviveStateRecursive(openTree(value, secrets, aad)),
        catch: (cause) => new StateCorrupt({ stack, stage, reason: `cannot decode state: ${String(cause)}` }),
      });

    const scoped = (request: { readonly stack: string; readonly stage?: string }) =>
      request.stack === stack && (request.stage === undefined || request.stage === stage);

    const toAlchemyError = (error: ProvisioningStateError) =>
      new StateStoreError({
        message: `${error._tag}: ${"reason" in error ? error.reason : ""}`.trim(),
        cause: error as unknown as Error,
      });

    const run = <A>(effect: Effect.Effect<A, ProvisioningStateError>) =>
      effect.pipe(Effect.mapError(toAlchemyError));

    const service = {
      id: "zelavis-provisioning",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => run(load().pipe(Effect.map(() => [stack] as readonly string[]))),
      listStages: (requested: string) =>
        run(load().pipe(Effect.map(() => (requested === stack ? [stage] : []) as readonly string[]))),
      get: (request: { stack: string; stage: string; fqn: string }) =>
        run(
          Effect.gen(function* () {
            const current = yield* load();
            const row = scoped(request) && request.stage === stage ? current.document.resources[request.fqn] : undefined;
            return row === undefined ? undefined : ((yield* openValue(row)) as PersistedState);
          }),
        ),
      getReplacedResources: (request: { stack: string; stage: string }) =>
        run(
          Effect.gen(function* () {
            const current = yield* load();
            if (!scoped(request) || request.stage !== stage) return [] as never[];
            const rows = yield* Effect.forEach(Object.values(current.document.resources), openValue, {
              concurrency: 1,
            });
            return rows.filter((row) => isObject(row) && row.status === "replaced") as never[];
          }),
        ),
      set: <V extends PersistedState>(request: { stack: string; stage: string; fqn: string; value: V }) =>
        run(
          Effect.gen(function* () {
            if (!scoped(request) || request.stage !== stage) {
              return yield* new StateCorrupt({ stack, stage, reason: "write outside the acquired stack and stage" });
            }
            const sealed = yield* sealValue(request.value);
            yield* mutate((document) => ({
              next: { ...document, resources: { ...document.resources, [request.fqn]: sealed } },
              result: undefined,
            }));
            return request.value;
          }),
        ),
      delete: (request: { stack: string; stage: string; fqn: string }) =>
        run(
          mutate((document) => {
            const { [request.fqn]: _removed, ...rest } = document.resources;
            return { next: { ...document, resources: rest }, result: undefined };
          }).pipe(Effect.asVoid),
        ),
      deleteStack: (request: { stack: string; stage?: string }) =>
        run(
          Effect.gen(function* () {
            if (!scoped(request)) return;
            const current = yield* load(true);
            const deleted = yield* call("compareAndDelete", () =>
              store.compareAndDelete(PROVISIONING_STATE_NAMESPACE, documentKey(stack, stage), current.updatedAt),
            );
            if (!deleted) return yield* new StateContention({ stack, stage, attempts: 1 });
            deletedByThisOwner = true;
          }),
        ),
      list: (request: { stack: string; stage: string }) =>
        run(
          load().pipe(
            Effect.map((current) =>
              scoped(request) && request.stage === stage
                ? (Object.keys(current.document.resources) as readonly string[])
                : ([] as readonly string[]),
            ),
          ),
        ),
      getOutput: (request: { stack: string; stage: string }) =>
        run(
          Effect.gen(function* () {
            const current = yield* load();
            return scoped(request) && request.stage === stage ? yield* openValue(current.document.outputs) : undefined;
          }),
        ),
      setOutput: (request: { stack: string; stage: string; value: unknown }) =>
        run(
          Effect.gen(function* () {
            const sealed = yield* sealValue(request.value);
            yield* mutate((document) => ({ next: { ...document, outputs: sealed }, result: undefined }));
            return request.value;
          }),
        ),
    };

    return {
      stack,
      stage,
      owner,
      epoch,
      layer: Layer.succeed(State, Effect.succeed(service as never)),
      service: service as unknown as StateService,
    } satisfies FencedState;
  }

  return { acquire };
}
