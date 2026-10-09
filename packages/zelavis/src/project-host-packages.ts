/**
 * What each approved package set makes available, by requirement name. A recipe's install
 * method names requirements (`nginx`, `php-fpm`); a host satisfies them by having them or by
 * being able to install the set that provides them through the audited host-operation broker.
 */
export const HOST_PACKAGE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "wordpress-stack": Object.freeze(["nginx", "php-fpm", "mariadb"]),
});

/** Requirement names this host can provide: only those a package set can install, and only when the operation Agent exists. */
export function provisionableRequirements(hostOperationsAvailable: boolean): readonly string[] {
  return hostOperationsAvailable ? Object.freeze(Object.values(HOST_PACKAGE_REQUIREMENTS).flat()) : Object.freeze([]);
}

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
