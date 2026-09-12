import { Schema } from "effect";
import type { OrderedScalar } from "./model.js";

/**
 * A query is data, not a function.
 *
 * This is the load-bearing decision in the whole routing design. A closure
 * cannot cross a network boundary — there is no serialization for it — so a
 * router that accepts `(store) => Effect<A>` can only ever run locally. Describe
 * the query instead and it can be validated, logged, cached, sent to whichever
 * node owns the partition, and answered there.
 */
export interface TermQuery {
  readonly _tag: "Term";
  readonly field: string;
  readonly term: string;
}

/**
 * Objects holding exactly this value in a column, read from the ordered lens.
 * Typed, as the lens is: `10`, `"10"` and `true` are three different values.
 */
export interface EqualsQuery {
  readonly _tag: "Equals";
  readonly column: string;
  readonly value: OrderedScalar;
}

export interface EdgeQuery {
  readonly _tag: "Edge";
  readonly edgeType: string;
  readonly from: number;
}

export interface AndQuery {
  readonly _tag: "And";
  readonly of: ReadonlyArray<Query>;
}

export interface OrQuery {
  readonly _tag: "Or";
  readonly of: ReadonlyArray<Query>;
}

/** One end of a range. */
export interface RangeBound {
  readonly value: OrderedScalar;
  readonly inclusive: boolean;
}

/**
 * Objects whose value in a column falls within a range, read from the ordered
 * lens.
 *
 * Values compare in the lens's one order — booleans, then numbers, then strings
 * by code point, then null — so a range means the same thing on every host and
 * every shard, and never borrows a locale. A range compares like with like: with
 * one bound, the other side stops at the edge of that bound's kind, so
 * `lt(column, 5)` is numbers below five and never the booleans sorting below
 * them. Two bounds of different kinds span every kind between them, and a range
 * with no bound is the whole column.
 */
export interface RangeQuery {
  readonly _tag: "Range";
  readonly column: string;
  readonly lower?: RangeBound;
  readonly upper?: RangeBound;
}

export type Query = TermQuery | EqualsQuery | EdgeQuery | RangeQuery | AndQuery | OrQuery;

const OrderedScalarWire = Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String]);
const RangeBoundWire = Schema.Struct({ value: OrderedScalarWire, inclusive: Schema.Boolean });

export const Query: Schema.Codec<Query> = Schema.Union([
  Schema.TaggedStruct("Term", { field: Schema.String, term: Schema.String }),
  Schema.TaggedStruct("Equals", { column: Schema.String, value: OrderedScalarWire }),
  Schema.TaggedStruct("Edge", { edgeType: Schema.String, from: Schema.Finite }),
  Schema.TaggedStruct("Range", {
    column: Schema.String,
    lower: Schema.optional(RangeBoundWire),
    upper: Schema.optional(RangeBoundWire),
  }),
  Schema.TaggedStruct("And", {
    of: Schema.Array(Schema.suspend((): Schema.Codec<Query> => Query)),
  }),
  Schema.TaggedStruct("Or", {
    of: Schema.Array(Schema.suspend((): Schema.Codec<Query> => Query)),
  }),
]);

export const term = (field: string, value: string): Query => ({
  _tag: "Term",
  field,
  term: value,
});

export const equals = (column: string, value: OrderedScalar): Query => ({
  _tag: "Equals",
  column,
  value,
});

export const edge = (edgeType: string, from: number): Query => ({
  _tag: "Edge",
  edgeType,
  from,
});

export const and = (...of: ReadonlyArray<Query>): Query => ({ _tag: "And", of });

export const or = (...of: ReadonlyArray<Query>): Query => ({ _tag: "Or", of });

/** Values strictly above `value`. */
export const gt = (column: string, value: OrderedScalar): Query => ({
  _tag: "Range",
  column,
  lower: { value, inclusive: false },
});

/** Values at or above `value`. */
export const gte = (column: string, value: OrderedScalar): Query => ({
  _tag: "Range",
  column,
  lower: { value, inclusive: true },
});

/** Values strictly below `value`. */
export const lt = (column: string, value: OrderedScalar): Query => ({
  _tag: "Range",
  column,
  upper: { value, inclusive: false },
});

/** Values at or below `value`. */
export const lte = (column: string, value: OrderedScalar): Query => ({
  _tag: "Range",
  column,
  upper: { value, inclusive: true },
});

/** Values from `low` to `high`, both included. */
export const between = (column: string, low: OrderedScalar, high: OrderedScalar): Query => ({
  _tag: "Range",
  column,
  lower: { value: low, inclusive: true },
  upper: { value: high, inclusive: true },
});
