/**
 * Typed URL search params for React Router.
 *
 * Usage:
 *   // Define schema at module level (stable reference)
 *   const storageSchema = {
 *     prefix: parseAsString,
 *     path: parseAsString,
 *   } satisfies SearchParamSchema;
 *
 *   // In component
 *   const [params, setParams] = useTypedSearchParams(storageSchema);
 *   // params.prefix: string | undefined
 *   // params.path: string | undefined
 *   setParams({ prefix: 'images/' });
 *   setParams({ prefix: null }); // removes from URL
 *
 * Single param shorthand:
 *   const [prefix, setPrefix] = useTypedSearchParam('prefix', parseAsString.withDefault(''));
 */

import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { mergeSearchParams, readSearchParams } from "#/lib/routing";

// ---------------------------------------------------------------------------
// Parser type
// ---------------------------------------------------------------------------

export type ParamParser<T> = {
  /** Parse a raw URL string value (or undefined if absent) into a typed value. */
  parse: (raw: string | undefined) => T;
  /** Serialize a typed value back to a URL string (undefined removes the key). */
  serialize: (value: T) => string | undefined;
  /**
   * Return a new parser that uses `defaultValue` when the param is absent,
   * and omits the param from the URL when the value equals `defaultValue`.
   */
  withDefault<D extends NonNullable<T>>(defaultValue: D): ParamParser<NonNullable<T>>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SearchParamSchema = Record<string, ParamParser<any>>;

// ---------------------------------------------------------------------------
// Internal factory — builds a parser with the fluent .withDefault() method
// ---------------------------------------------------------------------------

function createParser<T>(
  parse: (raw: string | undefined) => T,
  serialize: (value: T) => string | undefined,
): ParamParser<T> {
  return {
    parse,
    serialize,
    withDefault<D extends NonNullable<T>>(defaultValue: D): ParamParser<NonNullable<T>> {
      return createParser<NonNullable<T>>(
        (raw) => {
          const parsed = parse(raw);
          return (parsed === null || parsed === undefined
            ? defaultValue
            : parsed) as NonNullable<T>;
        },
        (value) => {
          // clearOnDefault: omit the param when it equals the default
          if (value === defaultValue) return undefined;
          return serialize(value as T);
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in parsers
// ---------------------------------------------------------------------------

/** Any string value. Absent param → undefined. */
export const parseAsString: ParamParser<string | undefined> = createParser(
  (raw) => raw,
  (value) => value,
);

/**
 * Validates the param against a set of allowed string literals.
 * Invalid or absent values → undefined.
 *
 * @example
 * const viewParser = parseAsStringLiteral(['grid', 'list'] as const);
 * // ParamParser<'grid' | 'list' | undefined>
 */
export function parseAsStringLiteral<T extends string>(
  validValues: readonly T[],
): ParamParser<T | undefined> {
  return createParser<T | undefined>(
    (raw) =>
      raw !== undefined && (validValues as readonly string[]).includes(raw)
        ? (raw as T)
        : undefined,
    (value) => value,
  );
}

// ---------------------------------------------------------------------------
// Inferred output type from a schema
// ---------------------------------------------------------------------------

type SchemaOutput<S extends SearchParamSchema> = {
  [K in keyof S]: S[K] extends ParamParser<infer T> ? T : never;
};

/** Values passed to the setter — each key can be set to T or null (removes from URL). */
type SetInput<S extends SearchParamSchema> = Partial<{
  [K in keyof S]: (S[K] extends ParamParser<infer T> ? T : never) | null;
}>;

type SetterFn<S extends SearchParamSchema> = (
  next: SetInput<S> | ((current: SchemaOutput<S>) => SetInput<S>),
  options?: { replace?: boolean },
) => void;

// ---------------------------------------------------------------------------
// useTypedSearchParams — multiple params
// ---------------------------------------------------------------------------

/**
 * Read and write multiple typed URL search params at once.
 *
 * @param schema  Object mapping param keys to parsers. Define at module level.
 * @param options Default navigation options (replace defaults to true).
 *
 * @example
 * const mediaSchema = {
 *   prefix: parseAsString,
 *   type:   parseAsString,
 *   path:   parseAsString,
 * } satisfies SearchParamSchema;
 *
 * const [params, setParams] = useTypedSearchParams(mediaSchema);
 * setParams({ prefix: 'uploads/' });
 * setParams({ prefix: null });         // removes ?prefix from URL
 * setParams(p => ({ type: p.type }));  // functional update
 * setParams({ path: '/img.png' }, { replace: false }); // push history
 */
export function useTypedSearchParams<S extends SearchParamSchema>(
  schema: S,
  options?: { replace?: boolean },
): [SchemaOutput<S>, SetterFn<S>] {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultReplace = options?.replace ?? true;

  const raw = useMemo(
    () => readSearchParams(location.search),
    [location.search],
  );

  // Parse all params — runs on every render but trivially fast
  const parsed = Object.fromEntries(
    Object.entries(schema).map(([key, parser]) => [key, parser.parse(raw[key])]),
  ) as SchemaOutput<S>;

  const setParams: SetterFn<S> = (next, callOptions) => {
    const resolved = typeof next === "function" ? next(parsed) : next;

    const serialized: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(resolved)) {
      if (value === null || value === undefined) {
        serialized[key] = undefined;
      } else {
        serialized[key] = (schema[key] as ParamParser<unknown>).serialize(value);
      }
    }

    navigate(
      {
        pathname: location.pathname,
        search: mergeSearchParams(location.search, serialized),
      },
      { replace: callOptions?.replace ?? defaultReplace },
    );
  };

  return [parsed, setParams];
}

// ---------------------------------------------------------------------------
// useTypedSearchParam — single param convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Read and write a single typed URL search param.
 *
 * @example
 * const [prefix, setPrefix] = useTypedSearchParam('prefix', parseAsString.withDefault(''));
 * setPrefix('images/');
 * setPrefix(null); // removes ?prefix from URL
 */
export function useTypedSearchParam<T>(
  key: string,
  parser: ParamParser<T>,
  options?: { replace?: boolean },
): [T, (value: T | null, options?: { replace?: boolean }) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const defaultReplace = options?.replace ?? true;

  const raw = useMemo(
    () => readSearchParams(location.search),
    [location.search],
  );

  const value = parser.parse(raw[key]);

  const setValue = (next: T | null, callOptions?: { replace?: boolean }) => {
    const serialized = next === null || next === undefined
      ? undefined
      : parser.serialize(next);

    navigate(
      {
        pathname: location.pathname,
        search: mergeSearchParams(location.search, { [key]: serialized }),
      },
      { replace: callOptions?.replace ?? defaultReplace },
    );
  };

  return [value, setValue];
}
