import { compareVersions } from "zelavis";
import type { AllowlistService, AllowlistVersion } from "./types.js";

/** Whether a Platform at `platform` runs this listed version. */
export function runsOn(version: AllowlistVersion, platform: string): boolean {
  return compareVersions(version.platform, platform) <= 0;
}

/**
 * The version an installation at `platform` is offered: `latest` when it runs
 * there, otherwise the newest version that does and is not deprecated. A list is
 * shared by every installation, old ones too, so what is newest is not always
 * what this one can run. `undefined` when no listed version runs on it.
 */
export function selectListedVersion(service: AllowlistService, platform: string): AllowlistVersion | undefined {
  const latest = service.versions.find((entry) => entry.version === service.latest);
  if (latest && runsOn(latest, platform)) return latest;
  return service.versions
    .filter((entry) => !entry.deprecated && runsOn(entry, platform))
    .sort((left, right) => compareVersions(right.version, left.version))[0];
}
