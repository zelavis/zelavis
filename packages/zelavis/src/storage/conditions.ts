import { ZelavisConflictError } from "../platform/shared.js";
import type {
  ZelavisFileStorage,
  ZelavisFileStorageCondition,
  ZelavisFileStorageEntry,
} from "../platform/storage-types.js";

/** A conditional write whose condition did not hold. Nothing was written. */
export class ZelavisStorageConditionError extends ZelavisConflictError {
  readonly path: string;
  readonly condition: ZelavisFileStorageCondition;

  constructor(path: string, condition: ZelavisFileStorageCondition) {
    super(
      "ifAbsent" in condition
        ? `Storage object "${path}" already exists.`
        : `Storage object "${path}" changed since it was read.`,
    );
    this.name = "ZelavisStorageConditionError";
    this.path = path;
    this.condition = condition;
  }
}

export type ZelavisFileStorageProbeResult =
  | { readonly conformant: true }
  | { readonly conformant: false; readonly violation: string };

export interface ZelavisFileStorageProbeOptions {
  /** Where the probe's one object is written, then removed. */
  readonly prefix?: string;
}

const decoder = new TextDecoder();

/**
 * Asks a store directly whether it enforces the conditional writes a lease, a
 * fence or an authoritative publication rests on.
 *
 * No provider documents this reliably, and a store can accept `If-None-Match`
 * and `If-Match` and ignore them — which fails late and silently, as two
 * owners of one thing. So the store is asked, on a fresh object, in the four
 * steps celld uses before a node serves (denoland/celld, `docs/guarantees.md`):
 *
 *   1. a create of an absent object applies, and returns its version;
 *   2. a second create is rejected;
 *   3. an update carrying the current version applies;
 *   4. an update carrying the now-stale version is rejected.
 *
 * Steps 2 and 4 are the fence. Between the steps, a read must return the last
 * write — read-after-write — or no reader can act on what a writer published.
 *
 * A result is a verdict: the store answered, and either kept every guarantee
 * or broke the one named. A thrown error is not a verdict. It means the store
 * answered a step with something other than success or a clean rejection — an
 * outage, or a store that cannot tell a lost race from a failed write — and
 * the probe can be retried.
 */
export async function probeFileStorageGuarantees(
  storage: ZelavisFileStorage,
  options: ZelavisFileStorageProbeOptions = {},
): Promise<ZelavisFileStorageProbeResult> {
  const path = `${options.prefix ?? "zelavis-probe"}/conditions-${Date.now()}-${crypto.randomUUID()}`;
  const violation = (message: string): ZelavisFileStorageProbeResult => ({
    conformant: false,
    violation: message,
  });

  /** The write's entry, or `undefined` when the store rejected its condition. */
  const attempt = async (
    body: string,
    condition: ZelavisFileStorageCondition,
    step: string,
  ): Promise<ZelavisFileStorageEntry | undefined> => {
    try {
      return await storage.put({ path, body, condition });
    } catch (error) {
      if (error instanceof ZelavisStorageConditionError) return undefined;
      throw new Error(
        `The storage probe could not complete step ${step}: the store answered a ` +
          "conditional write with an error rather than success or a clean rejection.",
        { cause: error },
      );
    }
  };

  /** A violation when a read does not return the last write, else `undefined`. */
  const readsBack = async (
    expected: string,
    etag: string,
  ): Promise<ZelavisFileStorageProbeResult | undefined> => {
    const object = await storage.get(path);
    if (object === undefined || decoder.decode(object.body) !== expected) {
      return violation(
        "a read after a successful write did not return that write, so a reader " +
          "cannot act on what a writer published",
      );
    }
    if (object.etag !== undefined && object.etag !== etag) {
      return violation(
        "a read returned a different version from the one the last write reported",
      );
    }
    return undefined;
  };

  try {
    const created = await attempt("probe-create", { ifAbsent: true }, "1");
    if (created === undefined) {
      return violation("the store rejected a conditional create of an object that does not exist");
    }
    if (created.etag === undefined) {
      return violation(
        "the store returned no version for a write, so no later write can be conditional on it",
      );
    }
    const first = created.etag;
    const afterCreate = await readsBack("probe-create", first);
    if (afterCreate) return afterCreate;

    if ((await attempt("probe-recreate", { ifAbsent: true }, "2")) !== undefined) {
      return violation(
        "the store overwrote an object although the write was conditional on it being " +
          "absent; it accepts the condition and does not enforce it, so two writers can " +
          "both believe they created one thing",
      );
    }

    const updated = await attempt("probe-update", { ifMatch: first }, "3");
    if (updated === undefined) {
      return violation("the store rejected a conditional update that carried the current version");
    }
    if (updated.etag === undefined || updated.etag === first) {
      return violation(
        "the store reported the same version after the object changed, so a stale " +
          "write cannot be told from a current one",
      );
    }
    const afterUpdate = await readsBack("probe-update", updated.etag);
    if (afterUpdate) return afterUpdate;

    if ((await attempt("probe-stale", { ifMatch: first }, "4")) !== undefined) {
      return violation(
        "the store applied a write conditional on a version that had already been " +
          "replaced; it accepts the condition and does not enforce it, so a fenced " +
          "writer can still overwrite its successor",
      );
    }
    const afterStale = await readsBack("probe-update", updated.etag);
    if (afterStale) return afterStale;

    return { conformant: true };
  } finally {
    // Debris on every path. A delete that fails leaves one small object under
    // the probe prefix, which nothing reads.
    await Promise.resolve(storage.delete(path)).catch(() => undefined);
  }
}
