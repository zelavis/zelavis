import type { AllowlistClient } from "./client.js";
import type { AllowlistService, AllowlistVersion } from "./types.js";

export type AllowlistRefusalCode =
  | "unavailable"
  | "expired"
  | "not_listed"
  | "version_not_listed"
  | "digest_mismatch";

export class AllowlistRefusal extends Error {
  constructor(readonly code: AllowlistRefusalCode, message: string) {
    super(message);
    this.name = "AllowlistRefusal";
  }
}

export interface AllowlistGate {
  /**
   * Before anything is fetched: is this exact package and version on the list?
   * Returns the entry, so a caller can see what the list vouches for.
   */
  authorize(input: {
    readonly name: string;
    readonly version: string;
  }): Promise<{ readonly service: AllowlistService; readonly version: AllowlistVersion }>;
  /**
   * After the bytes arrived: are they the bytes the list vouches for? A package
   * whose digest differs is refused even though its name and version match.
   */
  verifyAcquired(input: {
    readonly name: string;
    readonly version: string;
    readonly integrity: string;
  }): Promise<void>;
}

function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The install decision: only what the current, unexpired allow-list vouches for. */
export function createAllowlistGate(client: AllowlistClient): AllowlistGate {
  async function authorize(input: { name: string; version: string }) {
    const view = await client.current();
    if (!view) {
      throw new AllowlistRefusal("unavailable", "No allow-list is available, so nothing can be installed from the marketplace.");
    }
    if (view.status !== "fresh") {
      throw new AllowlistRefusal(
        "expired",
        view.status === "stale"
          ? "The marketplace allow-list is out of date and could not be refreshed, so nothing new can be installed yet."
          : "The marketplace allow-list has expired, so nothing can be installed from it.",
      );
    }
    const service = view.allowlist.services.find((entry) => entry.name === input.name);
    if (!service) {
      throw new AllowlistRefusal("not_listed", `"${input.name}" is not on the marketplace allow-list.`);
    }
    const version = service.versions.find((entry) => entry.version === input.version);
    if (!version) {
      throw new AllowlistRefusal(
        "version_not_listed",
        `Version ${input.version} of "${input.name}" is not on the marketplace allow-list.`,
      );
    }
    return { service, version };
  }

  return {
    authorize,
    async verifyAcquired(input) {
      const { version } = await authorize(input);
      if (!sameDigest(version.integrity, input.integrity)) {
        throw new AllowlistRefusal(
          "digest_mismatch",
          `"${input.name}@${input.version}" does not match the digest the allow-list vouches for.`,
        );
      }
    },
  };
}
