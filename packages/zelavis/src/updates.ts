/**
 * Updating an installation from its own dashboard.
 *
 * The Platform runs as an unprivileged service user, so it can neither replace
 * its own release nor restart itself. It only asks: a request file is dropped
 * where a root-owned systemd unit watches, and that unit runs the update. What
 * the request says is never trusted. The root updater looks up the newest
 * version for the installation's own channel on npm itself, refuses anything
 * that is not newer, and runs the installer shipped inside the installed
 * release, so the Platform can at worst ask for the update the operator could
 * have run by hand.
 *
 * An installation in the user's own home (macOS, or Linux without systemd) has
 * no root. Its persistent host runs the same handover, with the updater and
 * inventory acknowledgement performed by the installation's own user.
 *
 * This file is runtime-neutral: types, version ordering and the channel rule.
 * The Node bindings live in `adapters/_node-updates.ts` and the root updater in
 * `adapters/_update-runner.ts`.
 */

/** Where an update stands. `requested` is a request the root updater has not picked up yet. */
export type ZelavisUpdateState = "idle" | "requested" | "running" | "succeeded" | "failed" | "rolled-back";

export interface ZelavisUpdateRun {
  readonly id: string;
  readonly state: Exclude<ZelavisUpdateState, "idle" | "requested">;
  /** The version the update started from. */
  readonly from: string;
  /** The version it moved to, or tried to. */
  readonly to?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** One sentence in plain words: what happened, or why it did not. */
  readonly message?: string;
  /** The tail of the installer's output, for diagnosis. */
  readonly log?: readonly string[];
}

export interface ZelavisUpdateStatus {
  /** The version that is running now. */
  readonly current: string;
  /** `alpha` or `latest`, from the running version; absent for a build with no published channel. */
  readonly channel?: "alpha" | "latest";
  /** The newest version on that channel, once a check has succeeded. */
  readonly latest?: string;
  /** True when `latest` is newer than `current`. */
  readonly available: boolean;
  readonly checkedAt?: string;
  /** Why the last check failed, when it did. */
  readonly checkError?: string;
  /** Whether this installation can update itself. */
  readonly managed: boolean;
  readonly unmanagedReason?: string;
  readonly state: ZelavisUpdateState;
  /** The most recent update run, when there has been one. */
  readonly run?: ZelavisUpdateRun;
}

export interface ZelavisUpdateControl {
  /** What is known now, without a network call. */
  status(): Promise<ZelavisUpdateStatus>;
  /** Looks up the newest version on this installation's channel. */
  check(): Promise<ZelavisUpdateStatus>;
  /**
   * Asks for the update to the newest version. Returns at once with state
   * `requested`; the update itself runs as root and survives a Platform restart.
   */
  apply(requestedBy: string): Promise<ZelavisUpdateStatus>;
}

/** Raised for a request that cannot be honoured; the route turns it into a 409. */
export class ZelavisUpdateRefusal extends Error {
  readonly _tag = "ZelavisUpdateRefusal" as const;
  readonly code: "unmanaged" | "up-to-date" | "busy" | "unchecked";
  constructor(code: ZelavisUpdateRefusal["code"], message: string) {
    super(message);
    this.name = "ZelavisUpdateRefusal";
    this.code = code;
  }
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

/** An exact version, never a tag or a range. */
export function isExactVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && VERSION.test(value);
}

/** Orders versions by semver, including numeric prerelease parts (`alpha.9` < `alpha.10`). */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = VERSION.exec(value);
    if (!match) throw new Error(`Invalid version: ${value}`);
    return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") };
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i += 1) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! - b.numbers[i]!;
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The channel an installation follows, from the version it runs: a stable
 * version follows `latest`, an alpha follows `alpha`, and any other prerelease
 * has no channel, so it is never moved by itself.
 */
export function updateChannel(version: string): "alpha" | "latest" | undefined {
  const match = VERSION.exec(version);
  if (!match) return undefined;
  if (!match[4]) return "latest";
  return /^alpha\.\d+$/u.test(match[4]) ? "alpha" : undefined;
}

const RUN_STATES = new Set(["running", "succeeded", "failed", "rolled-back"]);

/** Reads a status file defensively: it is written by another process, so it is data. */
export function parseUpdateRun(value: unknown): ZelavisUpdateRun | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length > 128 || !RUN_STATES.has(String(record.state))) return undefined;
  if (!isExactVersion(record.from) || typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))) return undefined;
  const text = (field: unknown, limit: number) => typeof field === "string" ? field.slice(0, limit) : undefined;
  const to = isExactVersion(record.to) ? record.to : undefined;
  const finishedAt = typeof record.finishedAt === "string" && Number.isFinite(Date.parse(record.finishedAt)) ? record.finishedAt : undefined;
  const message = text(record.message, 500);
  const log = Array.isArray(record.log) ? record.log.filter((line): line is string => typeof line === "string").slice(-40).map((line) => line.slice(0, 400)) : undefined;
  return {
    id: record.id,
    state: record.state as ZelavisUpdateRun["state"],
    from: record.from,
    startedAt: record.startedAt,
    ...(to ? { to } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(message ? { message } : {}),
    ...(log && log.length > 0 ? { log } : {}),
  };
}
