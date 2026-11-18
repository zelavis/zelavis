/**
 * AuthDb: the database interface that Auth modules use, over one
 * `documents.transaction` of the Auth partition.
 *
 * Auth module code reads and writes through `tx.db.query(t)
 * .withIndex(i, q => q.eq(...).gte(...)).order("desc").first()`, `insert`,
 * `patch`, ...), and every operation joins the transaction: reads go into its
 * read set and writes are staged, so the whole body commits once or not at
 * all. Misuse (a range that does not follow the index, a second row for
 * `unique()`) dies with `AuthInvariantViolation`, as does a stored row its
 * table's schema cannot decode.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { Document, DocumentFilter, DocumentSort, DocumentTransaction, JsonObject } from "../../db/document-model.js";
import type { TransactionTooLarge } from "../../db/errors.js";
import type { Json } from "../../db/json.js";
import { type AuthIndex, type AuthRow, type AuthTableRef, BY_CREATION_TIME } from "./tables.js";

export type { AuthRow, AuthTableRef } from "./tables.js";

/** An Auth data-model rule was broken: a defect in module code, never an expected outcome. */
export class AuthInvariantViolation extends Schema.TaggedError<AuthInvariantViolation>()("AuthInvariantViolation", {
  message: Schema.String,
}) {}

export const invariant = (message: string): Effect.Effect<never> => Effect.die(new AuthInvariantViolation({ message }));

/** Rows `take` and `collect` return at most. */
export const AUTH_READ_LIMIT = 1000;

type Value = string | number | boolean | null;

interface RangeState {
  readonly eq: ReadonlyArray<readonly [string, Value]>;
  readonly lower?: readonly [string, "gt" | "gte", Value];
  readonly upper?: readonly [string, "lt" | "lte", Value];
}

/** Equalities on a prefix of the index, then one field's bounds. */
export interface AuthIndexRange {
  eq(field: string, value: Value): AuthIndexRange;
  gt(field: string, value: Value): AuthIndexRange;
  gte(field: string, value: Value): AuthIndexRange;
  lt(field: string, value: Value): AuthIndexRange;
  lte(field: string, value: Value): AuthIndexRange;
}

export interface AuthQuery<T extends AuthRow> {
  order(direction: "asc" | "desc"): AuthQuery<T>;
  first(): Effect.Effect<T | null, TransactionTooLarge>;
  /** The one matching row, null for none; two is a defect. */
  unique(): Effect.Effect<T | null, TransactionTooLarge>;
  take(n: number): Effect.Effect<ReadonlyArray<T>, TransactionTooLarge>;
  /** Every matching row, up to `AUTH_READ_LIMIT`; reaching it is a defect, since upstream collects only bounded sets. */
  collect(): Effect.Effect<ReadonlyArray<T>, TransactionTooLarge>;
}

export interface AuthQueryInitializer<T extends AuthRow> extends AuthQuery<T> {
  withIndex(name: string, range?: (q: AuthIndexRange) => AuthIndexRange): AuthQuery<T>;
}

type Insertable<T extends AuthRow> = Omit<T, "_id" | "_creationTime">;

export interface AuthDb {
  get<T extends AuthRow>(table: AuthTableRef<T>, id: string): Effect.Effect<T | null, TransactionTooLarge>;
  insert<T extends AuthRow>(table: AuthTableRef<T>, value: Insertable<T>, existingAccountId?: string): Effect.Effect<string, TransactionTooLarge>;
  /** Merges `value`; a field set to `undefined` is removed. */
  patch<T extends AuthRow>(table: AuthTableRef<T>, id: string, value: Partial<Insertable<T>>): Effect.Effect<void, TransactionTooLarge>;
  replace<T extends AuthRow>(table: AuthTableRef<T>, id: string, value: Insertable<T>): Effect.Effect<void, TransactionTooLarge>;
  delete<T extends AuthRow>(table: AuthTableRef<T>, id: string): Effect.Effect<void, TransactionTooLarge>;
  /** The id when it is one this database could have issued, null otherwise. */
  normalizeId<T extends AuthRow>(table: AuthTableRef<T>, id: string): string | null;
  query<T extends AuthRow>(table: AuthTableRef<T>): AuthQueryInitializer<T>;
}

const ID_PATTERN = /^[0-9a-f]{32}$/u;
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;
const isAccountTable = (table: { readonly collection: string }) => table.collection === "accounts_accounts";
const validId = (table: { readonly collection: string }, id: string) =>
  (isAccountTable(table) ? ACCOUNT_ID_PATTERN : ID_PATTERN).test(id);

const randomId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Creation times that strictly increase within one runtime. */
export interface CreationClock {
  next(now: number): number;
}

export function creationClock(): CreationClock {
  let last = -Infinity;
  return {
    next(now) {
      last = Math.max(now, last + 1 / 1024);
      return last;
    },
  };
}

// Drop fields whose value is `undefined`; JSON has no such value.
const defined = (value: Record<string, unknown>): JsonObject =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as JsonObject;

const RANGE_STATE = Symbol("AuthIndexRange.state");
type TrackedRange = AuthIndexRange & { readonly [RANGE_STATE]: RangeState };

function rangeBuilder(state: RangeState, index: AuthIndex): TrackedRange {
  const violation = (message: string): never => {
    throw new AuthInvariantViolation({ message: `withIndex("${index.name}"): ${message}` });
  };
  const bound = (op: "gt" | "gte" | "lt" | "lte", field: string, value: Value): AuthIndexRange => {
    // A bound names the field after the equalities, and only once per side.
    if (field !== index.fields[state.eq.length]) violation(`a range on ${field} must follow equalities on the fields before it`);
    const lower = op === "gt" || op === "gte";
    if (lower ? state.lower !== undefined : state.upper !== undefined) violation(`a second ${lower ? "lower" : "upper"} bound on ${field}`);
    return rangeBuilder(lower ? { ...state, lower: [field, op, value] } : { ...state, upper: [field, op, value] }, index);
  };
  return {
    [RANGE_STATE]: state,
    eq(field, value) {
      if (state.lower !== undefined || state.upper !== undefined) violation(`eq(${field}) after a range`);
      if (index.fields[state.eq.length] !== field) violation(`eq(${field}) must name the next index field, ${index.fields[state.eq.length] ?? "none"}`);
      return rangeBuilder({ ...state, eq: [...state.eq, [field, value]] }, index);
    },
    gt: (field, value) => bound("gt", field, value),
    gte: (field, value) => bound("gte", field, value),
    lt: (field, value) => bound("lt", field, value),
    lte: (field, value) => bound("lte", field, value),
  };
}

/** The range a query reads, built when it runs: a misuse throws inside `Effect.sync`, which is a defect. */
const buildRange = (index: AuthIndex, range: ((q: AuthIndexRange) => AuthIndexRange) | undefined): Effect.Effect<RangeState> =>
  Effect.sync(() => {
    const result = range === undefined ? rangeBuilder({ eq: [] }, index) : range(rangeBuilder({ eq: [] }, index));
    const state = (result as Partial<TrackedRange>)[RANGE_STATE];
    if (state === undefined) throw new AuthInvariantViolation({ message: `withIndex("${index.name}"): the range must return its builder` });
    return state;
  });

const filtersOf = (state: RangeState): ReadonlyArray<DocumentFilter> => [
  ...state.eq.map(([path, value]): DocumentFilter => ({ path, op: "eq", value: value as Json })),
  ...(state.lower ? [{ path: state.lower[0], op: state.lower[1], value: state.lower[2] as Json }] : []),
  ...(state.upper ? [{ path: state.upper[0], op: state.upper[1], value: state.upper[2] as Json }] : []),
];

// Ascending places a missing value first; descending reads the index backwards.
const orderOf = (index: AuthIndex, direction: "asc" | "desc"): ReadonlyArray<DocumentSort> =>
  index.fields.map((path) => ({ path, direction, nulls: direction === "asc" ? "first" : "last" }));

/** AuthDb over one document transaction. `now` and `clock` give inserts their `_creationTime`. */
export function authDb(tx: DocumentTransaction, now: number, clock: CreationClock): AuthDb {
  const decode = <T extends AuthRow>(table: AuthTableRef<T>, id: string, data: unknown): Effect.Effect<T> => {
    const exit = Schema.decodeUnknownExit(table.schema)(data);
    return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : invariant(`${table.collection} row ${id} does not match its table`);
  };
  const decodeDocument = <T extends AuthRow>(table: AuthTableRef<T>, document: Document) => decode(table, document.id, document.data);
  // A missing collection or unindexed field is a setup defect: `ensureTables` creates both.
  const asDefect = <A>(effect: Effect.Effect<A, TransactionTooLarge | { readonly _tag: "CollectionNotFound" | "UnindexedField" }>): Effect.Effect<A, TransactionTooLarge> =>
    effect.pipe(Effect.catchIf((error): error is Exclude<typeof error, TransactionTooLarge> => error._tag !== "TransactionTooLarge", (error) => Effect.die(error)));
  const existing = <T extends AuthRow>(table: AuthTableRef<T>, id: string, operation: string) =>
    Effect.flatMap(asDefect(tx.get({ collection: table.collection, id })), (document) =>
      document === undefined ? invariant(`${operation} on a missing ${table.collection} row ${id}`) : decodeDocument(table, document));

  const run = <T extends AuthRow>(table: AuthTableRef<T>, name: string, range: ((q: AuthIndexRange) => AuthIndexRange) | undefined, direction: "asc" | "desc", limit: number) =>
    Effect.gen(function* () {
      const index = table.indexes.get(name);
      if (index === undefined) return yield* invariant(`${table.collection} has no index ${name}`);
      const state = yield* buildRange(index, range);
      const documents = yield* asDefect(tx.find({ collection: table.collection, where: filtersOf(state), orderBy: orderOf(index, direction), limit }));
      const rows: T[] = [];
      for (const document of documents) rows.push(yield* decodeDocument(table, document));
      return rows;
    });

  const query = <T extends AuthRow>(table: AuthTableRef<T>, index: string, range: ((q: AuthIndexRange) => AuthIndexRange) | undefined, direction: "asc" | "desc"): AuthQuery<T> => ({
    order: (next) => query(table, index, range, next),
    first: () => Effect.map(run(table, index, range, direction, 1), (rows) => rows[0] ?? null),
    unique: () => Effect.flatMap(run(table, index, range, direction, 2), (rows) =>
      rows.length > 1 ? invariant(`unique() found two rows in ${table.collection} by ${index}`) : Effect.succeed(rows[0] ?? null)),
    take: (n) => Number.isInteger(n) && n >= 0 && n <= AUTH_READ_LIMIT
      ? n === 0 ? Effect.succeed([]) : run(table, index, range, direction, n)
      : invariant(`take(${n}) must be an integer from 0 to ${AUTH_READ_LIMIT}`),
    collect: () => Effect.flatMap(run(table, index, range, direction, AUTH_READ_LIMIT), (rows) =>
      rows.length >= AUTH_READ_LIMIT ? invariant(`collect() on ${table.collection} by ${index} reached ${AUTH_READ_LIMIT} rows`) : Effect.succeed(rows)),
  });

  return {
    get: (table, id) =>
      validId(table, id)
        ? Effect.flatMap(asDefect(tx.get({ collection: table.collection, id })), (document) => document === undefined ? Effect.succeed(null) : decodeDocument(table, document))
        : Effect.succeed(null),
    insert: (table, value, existingAccountId) => Effect.gen(function* () {
      if (existingAccountId !== undefined && (!isAccountTable(table) || !validId(table, existingAccountId))) {
        return yield* invariant("Only account import can supply a valid existing account id.");
      }
      const _id = existingAccountId ?? randomId();
      const row = { ...defined(value as Record<string, unknown>), _id, _creationTime: clock.next(now) };
      yield* decode(table, _id, row);
      yield* tx.insert({ collection: table.collection, id: _id, data: row });
      return _id;
    }),
    patch: (table, id, value) => Effect.gen(function* () {
      const current = yield* existing(table, id, "patch");
      const merged = { ...current, ...value } as Record<string, unknown>;
      const row = { ...defined(merged), _id: current._id, _creationTime: current._creationTime };
      yield* decode(table, id, row);
      yield* asDefect(tx.update({ collection: table.collection, id, data: row, mode: "replace" }));
    }),
    replace: (table, id, value) => Effect.gen(function* () {
      const current = yield* existing(table, id, "replace");
      const row = { ...defined(value as Record<string, unknown>), _id: current._id, _creationTime: current._creationTime };
      yield* decode(table, id, row);
      yield* asDefect(tx.update({ collection: table.collection, id, data: row, mode: "replace" }));
    }),
    delete: (table, id) => Effect.gen(function* () {
      yield* existing(table, id, "delete");
      yield* asDefect(tx.delete({ collection: table.collection, id }));
    }),
    normalizeId: (table, id) => validId(table, id) ? id : null,
    query: <T extends AuthRow>(table: AuthTableRef<T>): AuthQueryInitializer<T> => ({
      ...query(table, BY_CREATION_TIME, undefined, "asc"),
      withIndex: (name, range) => query(table, name, range, "asc"),
    }),
  };
}
