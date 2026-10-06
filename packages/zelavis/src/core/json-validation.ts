/** Decoding is an authority boundary: callers supply a complete runtime contract. */
export type JsonValidator<A> = (value: unknown) => value is A;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const isString: JsonValidator<string> = (value): value is string => typeof value === "string";
export const isBoolean: JsonValidator<boolean> = (value): value is boolean => typeof value === "boolean";
export const isFiniteNumber: JsonValidator<number> = (value): value is number => typeof value === "number" && Number.isFinite(value);
export const isSafeInteger: JsonValidator<number> = (value): value is number => typeof value === "number" && Number.isSafeInteger(value);
export const isPositiveInteger: JsonValidator<number> = (value): value is number => isSafeInteger(value) && value > 0;
export const isNonNegativeInteger: JsonValidator<number> = (value): value is number => isSafeInteger(value) && value >= 0;
export const isTimestamp: JsonValidator<string> = (value): value is string => isString(value) && Number.isFinite(Date.parse(value));
export const isUnknown: JsonValidator<unknown> = (_value): _value is unknown => true;
export const optional = <A>(check: JsonValidator<A>): JsonValidator<A | undefined> =>
  (value): value is A | undefined => value === undefined || check(value);
export const arrayOf = <A>(check: JsonValidator<A>): JsonValidator<ReadonlyArray<A>> =>
  (value): value is ReadonlyArray<A> => Array.isArray(value) && value.every(check);
export const recordOf = <A>(check: JsonValidator<A>): JsonValidator<Readonly<Record<string, A>>> =>
  (value): value is Readonly<Record<string, A>> => isRecord(value) && Object.values(value).every(check);
export const literal = <const A extends string | number | boolean | null>(...values: readonly A[]): JsonValidator<A> =>
  (value): value is A => values.some(candidate => candidate === value);
/** All declared fields, including optional ones, must have a validator. Extras survive. */
export const objectFields = <A>(checks: { readonly [K in keyof A]-?: JsonValidator<A[K]> }): JsonValidator<A> =>
  (value): value is A => isRecord(value) && Object.entries(checks).every(([key, check]) =>
    Object.hasOwn(value, key) ? (check as JsonValidator<unknown>)(value[key]) : (check as JsonValidator<unknown>)(undefined));

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Iterative validation avoids recursion on attacker-controlled persisted data. */
export const isJsonValue: JsonValidator<JsonValue> = (value): value is JsonValue => {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 1_000_000) return false;
    const current = pending.pop();
    if (current === null || typeof current === "boolean" || typeof current === "string" || isFiniteNumber(current)) continue;
    if (Array.isArray(current)) {
      if (current.length > 1_000_000 - visited - pending.length) return false;
      for (const child of current) pending.push(child);
    }
    else if (isRecord(current)) {
      const children = Object.values(current);
      if (children.length > 1_000_000 - visited - pending.length) return false;
      for (const child of children) pending.push(child);
    }
    else return false;
  }
  return true;
};
export const isJsonObject: JsonValidator<{ [key: string]: JsonValue }> = (value): value is { [key: string]: JsonValue } => isRecord(value) && isJsonValue(value);

export function parseJson<A>(source: string, check: JsonValidator<A>, context = "JSON record"): A {
  if (source.length > 64 * 1024 * 1024) throw new Error(`${context} exceeds the 64 Mi code-unit decode limit`);
  const value: unknown = JSON.parse(source);
  if (!check(value)) throw new Error(`Malformed ${context}`);
  return value;
}
export const parseJsonObject = (source: string): Record<string, unknown> => parseJson(source, isRecord);
