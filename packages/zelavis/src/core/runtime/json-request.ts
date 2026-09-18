/** JSON cannot carry non-finite numbers; refuse rather than silently send null. */
export function stringifyJsonRequest(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new TypeError("JSON request numbers must be finite.");
    }
    return item;
  });
}
