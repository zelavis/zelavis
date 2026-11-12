/** Materialized measure queries: immutable definitions and atomic result/checkpoint publication. */
import { Effect, Stream } from "effect";
import { isJsonObject, isString, isTimestamp, parseJson } from "../core/json-validation.js";
import { AggregateChanged, AggregateNotFound, AggregateRefused, dieUnlessMoving, type TenantMoving, type CursorMismatch } from "./errors.js";
import type { DocumentsApi, GroupedSummary, MeasureOperation, MeasureHistogram, Summary, SummarizeInput, MeasureQueryError } from "./document-model.js";
import type { Seq } from "./model.js";
import type { EventCursor } from "./events.js";
import { equals } from "./query.js";
import type { ObjectStoreApi, Txn } from "./store.js";
import { isValidCollectionName } from "./naming.js";
import { histogramOf } from "./measure-statistics.js";
import type { TenantId } from "./topology.js";

export type MaterializedMeasure =
  | { readonly name: string; readonly op: MeasureOperation; readonly measure: string; readonly groupBy?: string; readonly groups?: number }
  | { readonly name: string; readonly op: "covariance"; readonly measure: string; readonly with: string; readonly sample?: boolean }
  | { readonly name: string; readonly op: "histogram"; readonly measure: string; readonly boundaries?: ReadonlyArray<number>; readonly bins?: number; readonly min?: number; readonly max?: number };
export interface AggregateDefinition extends Omit<SummarizeInput, "measure" | "op"> {
  readonly name: string;
  readonly operations: ReadonlyArray<MaterializedMeasure>;
}
export interface MaterializedAggregate extends AggregateDefinition {
  readonly createdAt: string;
  readonly refreshedAt?: string;
  /** The source partition's log head in the snapshot used to compute every result. */
  readonly checkpoint?: EventCursor;
  readonly results?: Readonly<Record<string, Summary | MeasureHistogram | ReadonlyArray<GroupedSummary>>>;
}
export interface AggregatesApi {
  readonly define: (definition: AggregateDefinition) => Effect.Effect<MaterializedAggregate, AggregateRefused | TenantMoving>;
  readonly list: Effect.Effect<ReadonlyArray<MaterializedAggregate>>;
  readonly get: (name: string) => Effect.Effect<MaterializedAggregate, AggregateNotFound>;
  readonly refresh: (name: string) => Effect.Effect<MaterializedAggregate, AggregateNotFound | AggregateChanged | AggregateRefused | TenantMoving>;
  readonly drop: (name: string) => Effect.Effect<{ readonly name: string }, AggregateNotFound | TenantMoving>;
}
const NS = "zv.aggregate", COLUMN = "zv.aggregate";
const MAX_DEFINITIONS = 128, MAX_DEFINITION_BYTES = 64 * 1024, MAX_RESULT_BYTES = 2 * 1024 * 1024;
const OPERATIONS = new Set(["count", "sum", "avg", "min", "max", "variance", "stddev", "countDistinct"]);
const encoder = new TextEncoder(), decoder = new TextDecoder();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const checkDefinition = (input: AggregateDefinition): AggregateDefinition => {
  const fail = (reason: string): never => { throw new AggregateRefused({ name: typeof input?.name === "string" ? input.name : "", reason }); };
  if (!record(input) || !isValidCollectionName(input.name) || !isValidCollectionName(input.collection)) fail("valid aggregate and collection names are required");
  if (encoder.encode(JSON.stringify(input)).length > MAX_DEFINITION_BYTES) fail("an aggregate definition is limited to 64 KiB");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 16) fail("an aggregate needs 1 to 16 operations");
  const names = new Set<string>();
  for (const operation of input.operations) {
    if (!record(operation) || !isValidCollectionName(operation.name) || names.has(operation.name) || typeof operation.measure !== "string" || operation.measure.length === 0) fail("operation names must be distinct and each operation must name a measure");
    names.add(operation.name);
    if (operation.op === "covariance") {
      if (typeof operation.with !== "string" || !operation.with || (operation.sample !== undefined && typeof operation.sample !== "boolean")) fail("covariance needs another measure and an optional boolean sample flag");
    } else if (operation.op === "histogram") {
      try { histogramOf([], operation); } catch (cause) { fail(cause instanceof Error && "reason" in cause ? String(cause.reason) : "invalid histogram options"); }
    } else if (!OPERATIONS.has(operation.op)) fail(`unknown measure operation ${String(operation.op)}`);
    else if (operation.groupBy !== undefined && (typeof operation.groupBy !== "string" || !operation.groupBy || (operation.groups !== undefined && (!Number.isInteger(operation.groups) || operation.groups < 1 || operation.groups > 1000)))) fail("groupBy needs a field and groups from 1 to 1000");
  }
  const operations = input.operations.map((operation): MaterializedMeasure => {
    const base = { name: operation.name, measure: operation.measure };
    if (operation.op === "covariance") return { ...base, op: operation.op, with: operation.with, ...(operation.sample === undefined ? {} : { sample: operation.sample }) };
    if (operation.op === "histogram") return { ...base, op: operation.op, ...(operation.boundaries === undefined ? {} : { boundaries: [...operation.boundaries] }), ...(operation.bins === undefined ? {} : { bins: operation.bins }), ...(operation.min === undefined ? {} : { min: operation.min }), ...(operation.max === undefined ? {} : { max: operation.max }) };
    return { ...base, op: operation.op, ...(operation.groupBy === undefined ? {} : { groupBy: operation.groupBy }), ...(operation.groups === undefined ? {} : { groups: operation.groups }) };
  });
  // A copy, so a stored definition shares nothing with the caller's object.
  return structuredClone<AggregateDefinition>({ name: input.name, collection: input.collection, operations,
    ...(input.where === undefined ? {} : { where: input.where }), ...(input.related === undefined ? {} : { related: input.related }),
    ...(input.search === undefined ? {} : { search: input.search }), ...(input.geometry === undefined ? {} : { geometry: input.geometry }),
    ...(input.linked === undefined ? {} : { linked: input.linked }),
  });
};
const storedRecord = (value: unknown): value is MaterializedAggregate => record(value) && isString(value.name) && isString(value.collection) && Array.isArray(value.operations) && isTimestamp(value.createdAt);
const decode = (bytes: Uint8Array): MaterializedAggregate => {
  const value = parseJson(decoder.decode(bytes), storedRecord, "materialized aggregate");
  checkDefinition(value);
  if ((value.refreshedAt !== undefined && !isTimestamp(value.refreshedAt)) || (value.checkpoint !== undefined && typeof value.checkpoint !== "string") || (value.results !== undefined && !isJsonObject(value.results))) throw new Error("materialized aggregate metadata is malformed");
  return value;
};

export const aggregatesFor = (store: ObjectStoreApi, documents: DocumentsApi, tenant: TenantId): AggregatesApi => {
  const read = (name: string) => Effect.gen(function* () {
    const seq = yield* store.lookup(NS, name);
    if (seq === undefined) return undefined;
    const object = yield* store.read(seq);
    return object === undefined ? undefined : { seq, version: object.version, value: decode(object.bytes) };
  }).pipe(Effect.orDie);
  const get = (name: string) => Effect.gen(function* () {
    const held = yield* read(name);
    return held === undefined ? yield* new AggregateNotFound({ name }) : held.value;
  });
  const put = (txn: Txn, seq: Seq, value: MaterializedAggregate) => txn.put(seq, encoder.encode(JSON.stringify(value)), {
    terms: [], columns: [[COLUMN, tenant]], measures: [], edges: [],
  }, { namespace: NS, key: value.name });
  return {
    define: (input) => Effect.gen(function* () {
      const definition = yield* Effect.try({ try: () => checkDefinition(input), catch: cause => cause instanceof AggregateRefused ? cause : new AggregateRefused({ name: input?.name ?? "", reason: "invalid aggregate definition" }) });
      return yield* store.transact(txn => Effect.gen(function* () {
        if ((yield* read(definition.name)) !== undefined) return yield* new AggregateRefused({ name: definition.name, reason: "already defined; drop it to change its definition" });
        if ((yield* store.namespaceSize(NS)) >= MAX_DEFINITIONS) return yield* new AggregateRefused({ name: definition.name, reason: "a partition holds at most 128 aggregate definitions" });
        const value = { ...definition, createdAt: new Date().toISOString() };
        yield* put(txn, yield* txn.allocate, value);
        return value;
      })).pipe(dieUnlessMoving);
    }),
    list: Effect.gen(function* () {
      const found: MaterializedAggregate[] = [];
      for (const seq of yield* Stream.runCollect(store.resolve(equals(COLUMN, tenant)))) {
        const object = yield* store.read(seq);
        if (object !== undefined) found.push(decode(object.bytes));
      }
      return found.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }).pipe(Effect.orDie),
    get,
    refresh: (name) => Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        // All query results and their source checkpoint come from one snapshot.
        const computed = yield* store.reading(Effect.gen(function* () {
          const held = yield* read(name);
          if (held === undefined) return yield* new AggregateNotFound({ name });
          const checkpoint = yield* store.events.head;
          const results: Record<string, Summary | MeasureHistogram | ReadonlyArray<GroupedSummary>> = Object.create(null);
          const { name: _name, operations, createdAt, refreshedAt: _refreshedAt, results: _results, checkpoint: _checkpoint, ...query } = held.value;
          for (const operation of operations) {
            const answer: Effect.Effect<Summary | MeasureHistogram | ReadonlyArray<GroupedSummary>, MeasureQueryError | CursorMismatch> = operation.op === "covariance" ? documents.covariance({ ...query, ...operation })
              : operation.op === "histogram" ? documents.histogram({ ...query, ...operation })
                : operation.groupBy === undefined ? documents.summarize({ ...query, ...operation })
                  : documents.summarizeBy({ ...query, ...operation, groupBy: operation.groupBy });
            results[operation.name] = yield* answer.pipe(Effect.catch(error => Effect.fail(new AggregateRefused({ name, reason: `${operation.name}: ${error._tag}` }))));
          }
          const value: MaterializedAggregate = {
            ...held.value, createdAt, results, refreshedAt: new Date().toISOString(),
            ...(checkpoint === undefined ? {} : { checkpoint }),
          };
          if (!isJsonObject(results) || encoder.encode(JSON.stringify(value)).length > MAX_RESULT_BYTES) return yield* new AggregateRefused({ name, reason: "aggregate results must be finite JSON within 2 MiB" });
          return { ...held, value, checkpoint };
        })).pipe(dieUnlessMoving);
        const published = yield* store.transact(txn => Effect.gen(function* () {
          // Re-read under the writer: never publish an older result or advance
          // its checkpoint beyond the source state actually used to compute it.
          const current = yield* read(name);
          if (current === undefined) return yield* new AggregateNotFound({ name });
          if (current.seq !== computed.seq || current.version !== computed.version || (yield* store.events.head) !== computed.checkpoint) return false;
          yield* put(txn, current.seq, computed.value);
          return true;
        })).pipe(dieUnlessMoving);
        if (published) return computed.value;
      }
      return yield* new AggregateChanged({ name, reason: "the source or definition changed during three refresh attempts; retry" });
    }),
    drop: (name) => store.transact(txn => Effect.gen(function* () {
      const held = yield* read(name);
      if (held === undefined) return yield* new AggregateNotFound({ name });
      yield* txn.retract(held.seq);
      return { name };
    })).pipe(dieUnlessMoving),
  };
};
