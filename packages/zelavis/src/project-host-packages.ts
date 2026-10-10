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
 * The package sets a recipe still needs on this platform with the install method a Project is created with. A set
 * is unnecessary when every requirement it provides is brought by the recipe itself: a runtime for this method with
 * a download for this platform that names the requirement as its `hostRequirement` (MariaDB on Linux x86_64), or a
 * method that runs that program from a container image (`containers.database` stands for `mariadb`). Platforms
 * without a build keep the set.
 */
export function neededHostPackages(
  sets: readonly string[],
  install: {
    readonly methods: ReadonlyArray<{ readonly id: string; readonly containers?: Readonly<Record<string, string>> }>;
    readonly runtimes?: ReadonlyArray<{ readonly hostRequirement?: string; readonly methods?: readonly string[]; readonly downloads: Readonly<Record<string, unknown>> }>;
  } | undefined,
  platform: string | undefined,
  methodId?: string,
): readonly string[] {
  const method = install?.methods.find((candidate) => methodId === undefined ? candidate === install.methods[0] : candidate.id === methodId);
  const brought = new Set((install?.runtimes ?? [])
    .filter((runtime) => platform !== undefined && runtime.downloads[platform] !== undefined && runtime.hostRequirement !== undefined
      && (runtime.methods === undefined || method === undefined || runtime.methods.includes(method.id)))
    .map((runtime) => runtime.hostRequirement!));
  if (method?.containers?.database !== undefined) brought.add("mariadb");
  return Object.freeze(sets.filter((set) => {
    const provided = HOST_PACKAGE_REQUIREMENTS[set];
    return provided === undefined || !provided.every((requirement) => brought.has(requirement));
  }));
}
