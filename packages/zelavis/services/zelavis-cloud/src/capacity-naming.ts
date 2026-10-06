import { createHash } from "node:crypto";

/**
 * A provisioned machine's identity must be derivable from the capacity request
 * alone. Alchemy's own physical names carry a random suffix that lives only in
 * its state, so a crash after the cloud call plus lost state would create a
 * second machine nobody ever deletes. A name computed from `requestId` lets a
 * retry find and adopt the machine instead.
 */

/** Hetzner server names are hostnames: lowercase, digits, hyphen, at most 63. */
const MAX_NAME_LENGTH = 63;
const NAME_PREFIX = "zelavis-";
const HASH_LENGTH = 12;
/** Room for the prefix, a `-` separator and the hash. */
const MAX_SLUG_LENGTH = MAX_NAME_LENGTH - NAME_PREFIX.length - 1 - HASH_LENGTH;

export const MANAGED_LABEL = "zelavis.io/managed";
export const PLATFORM_LABEL = "zelavis.io/platform";
export const REQUEST_LABEL = "zelavis.io/request";
export const CLASS_LABEL = "zelavis.io/class";
/** Operator labels live under this prefix, so they cannot collide with ours or another tool's. */
export const USER_LABEL_PREFIX = "zelavis.io/";

export interface CapacityIdentityInput {
  /** Stable caller-generated idempotency key of the capacity request. */
  readonly requestId: string;
  readonly platformId: string;
}

export interface CapacityIdentity {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

function requireText(label: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

/**
 * Deterministic, collision-resistant machine name for a capacity request. The
 * readable slug is cosmetic; uniqueness comes from the hash of the exact id, so
 * two ids that normalize to the same slug still get different names.
 */
export function capacityNodeName(requestId: string): string {
  requireText("requestId", requestId);
  const readable = slug(requestId);
  return `${NAME_PREFIX}${readable === "" ? "node" : readable}-${hash(requestId)}`;
}

/**
 * Cloud label values allow at most 63 characters of a restricted charset, so
 * identifiers are carried as hashes. The labels let `list` and `get` find what
 * Zelavis created, and let release refuse anything it did not label itself.
 */
/** The label value that identifies one Platform on the machines it created. */
export function platformLabelValue(platformId: string): string {
  requireText("platformId", platformId);
  return hash(platformId);
}

export function capacityLabels(input: CapacityIdentityInput): Record<string, string> {
  requireText("requestId", input.requestId);
  requireText("platformId", input.platformId);
  return {
    [MANAGED_LABEL]: "true",
    [PLATFORM_LABEL]: platformLabelValue(input.platformId),
    [REQUEST_LABEL]: hash(input.requestId),
  };
}

export function capacityIdentity(input: CapacityIdentityInput): CapacityIdentity {
  return {
    name: capacityNodeName(input.requestId),
    labels: capacityLabels(input),
  };
}
