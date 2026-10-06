/** Named host-operation package sets; recipes cannot supply package names or commands. */
export function normalizeProjectHostPackages(value: unknown): readonly string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8 ||
      value.some((set) => typeof set !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(set)) ||
      new Set(value).size !== value.length) {
    throw new TypeError("Project hostPackages must contain at most eight distinct named package sets.");
  }
  return Object.freeze([...value]);
}
