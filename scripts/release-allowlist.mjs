import { isDeepStrictEqual } from "node:util";

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The oldest Zelavis a service runs on, from its `peerDependencies.zelavis`. Only `>=<exact version>` is
 * accepted: the allow-list records one minimum per version, and a range with an upper bound or an `||`
 * would say something the list cannot carry.
 */
export function minimumPlatform(range, where) {
  const minimum = typeof range === "string" ? /^>=\s*(\S+)$/.exec(range.trim())?.[1] : undefined;
  if (!minimum || !EXACT.test(minimum)) {
    throw new Error(`${where} must declare peerDependencies.zelavis as ">=<exact version>" (found ${JSON.stringify(range)}).`);
  }
  return minimum;
}

/** A fresh Platform must offer the recipe versions qualified with this release. */
export function assertReleaseAllowlist(snapshot, manifests) {
  for (const manifest of manifests) {
    const service = snapshot.services.find((entry) => entry.name === manifest.name);
    // Each listed version's minimum Platform is checked when it is listed (`pnpm allowlist update`), from the
    // manifest that is published: the publisher refuses a tarball that is not the listed one, so it cannot drift.
    // The checkout's own range is not compared, because versioning moves it for versions already on npm.
    if (service?.latest !== manifest.version || !service.versions.some((entry) => entry.version === manifest.version)) {
      throw new Error(`${manifest.name}@${manifest.version} is not the shipped allow-list default. Run pnpm allowlist update, commit, and qualify again.`);
    }
    for (const field of ["managed", "hostPackages", "runtimeKinds"]) {
      if (!isDeepStrictEqual(service[field], manifest.zelavis?.project?.[field]))
        throw new Error(`${manifest.name} has stale ${field} metadata in the shipped allow-list. Run pnpm allowlist update before publishing.`);
    }
  }
}
