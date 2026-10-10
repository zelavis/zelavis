/**
 * What each approved package set makes available, by requirement name. A recipe's install
 * method names requirements (`nginx`, `php-fpm`); a host satisfies them by having them or by
 * being able to install the set that provides them through the audited host-operation broker.
 */
export const HOST_PACKAGE_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "wordpress-stack": Object.freeze(["nginx", "php-fpm", "mariadb"]),
  "mariadb-server": Object.freeze(["mariadb"]),
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

/**
 * The package sets a recipe still needs on this platform. A set is unnecessary when every requirement it
 * provides is brought by the recipe itself here: a runtime with a download for this platform that names the
 * requirement as its `hostRequirement` (MariaDB on Linux x86_64). Platforms without a build keep the set.
 */
export function neededHostPackages(
  sets: readonly string[],
  runtimes: ReadonlyArray<{ readonly hostRequirement?: string; readonly downloads: Readonly<Record<string, unknown>> }> | undefined,
  platform: string | undefined,
): readonly string[] {
  const brought = new Set((runtimes ?? [])
    .filter((runtime) => platform !== undefined && runtime.downloads[platform] !== undefined && runtime.hostRequirement !== undefined)
    .map((runtime) => runtime.hostRequirement!));
  return Object.freeze(sets.filter((set) => {
    const provided = HOST_PACKAGE_REQUIREMENTS[set];
    return provided === undefined || !provided.every((requirement) => brought.has(requirement));
  }));
}
