import { Effect } from "effect";
import type { AllowlistClient } from "./client.js";
import { runsOn } from "./select.js";
import type { AllowlistService, AllowlistVersion } from "./types.js";

export type AllowlistRefusalCode =
  | "unavailable"
  | "expired"
  | "not_listed"
  | "version_not_listed"
  | "platform_too_old"
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

/**
 * The install decision: only what the current, unexpired allow-list vouches for,
 * and only a version that runs on this Platform (`platform`, its exact version).
 */
export function createAllowlistGate(client: AllowlistClient, options: { readonly platform: string }): AllowlistGate {
  const authorize = Effect.fn("allowlist.authorize")(function* (input: { name: string; version: string }) {
    const view = yield* Effect.tryPromise({ try: () => client.current(), catch: (cause) => cause });
    if (!view) {
      return yield* Effect.fail(new AllowlistRefusal("unavailable", "No allow-list is available, so nothing can be installed from the marketplace."));
    }
    if (view.status !== "fresh") {
      return yield* Effect.fail(new AllowlistRefusal(
        "expired",
        view.status === "stale"
          ? "The marketplace allow-list is out of date and could not be refreshed, so nothing new can be installed yet."
          : "The marketplace allow-list has expired, so nothing can be installed from it.",
      ));
    }
    const service = view.allowlist.services.find((entry) => entry.name === input.name);
    if (!service) {
      return yield* Effect.fail(new AllowlistRefusal("not_listed", `"${input.name}" is not on the marketplace allow-list.`));
    }
    const version = service.versions.find((entry) => entry.version === input.version);
    if (!version) {
      return yield* Effect.fail(new AllowlistRefusal(
        "version_not_listed",
        `Version ${input.version} of "${input.name}" is not on the marketplace allow-list.`,
      ));
    }
    if (!runsOn(version, options.platform)) {
      return yield* Effect.fail(new AllowlistRefusal(
        "platform_too_old",
        `${input.name}@${input.version} needs Zelavis ${version.platform} or newer, and this Platform runs ${options.platform}. Update Zelavis first, then install it.`,
      ));
    }
    return { service, version };
  });

  const verifyAcquired = Effect.fn("allowlist.verifyAcquired")(function* (input: { readonly name: string; readonly version: string; readonly integrity: string }) {
    const { version } = yield* authorize(input);
    if (!sameDigest(version.integrity, input.integrity)) {
      return yield* Effect.fail(new AllowlistRefusal(
        "digest_mismatch",
        `"${input.name}@${input.version}" does not match the digest the allow-list vouches for.`,
      ));
    }
  });

  return {
    authorize: (input) => Effect.runPromise(authorize(input)),
    verifyAcquired: (input) => Effect.runPromise(verifyAcquired(input)),
  };
}
