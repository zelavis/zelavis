import { Schema } from "effect";

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

export interface EqualsQuery {
  readonly _tag: "Equals";
  readonly column: string;
  readonly value: string;
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

export type Query = TermQuery | EqualsQuery | EdgeQuery | AndQuery | OrQuery;

export const Query: Schema.Codec<Query> = Schema.Union([
  Schema.TaggedStruct("Term", { field: Schema.String, term: Schema.String }),
  Schema.TaggedStruct("Equals", { column: Schema.String, value: Schema.String }),
  Schema.TaggedStruct("Edge", { edgeType: Schema.String, from: Schema.Finite }),
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

export const equals = (column: string, value: string): Query => ({
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
