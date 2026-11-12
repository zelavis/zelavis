import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { integration, IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";

const execFileAsync = promisify(execFile);
/** Bound the walk across the unit and its delegated subgroups. */
const MAX_UNIT_CGROUPS = 1024;
const MAX_UNIT_PROCESSES = 16_384;

/**
 * The refreshed units whose templates set `OOMScoreAdjust=`. Templates of a named
 * instance (`zelavis@.service`) govern that instance's unit (`zelavis@<instance>.service`).
 */
export function unitsWithOomScores(
  assets: readonly { readonly path: string; readonly content: string }[], instance: string,
): readonly string[] {
  const units: string[] = [];
  for (const asset of assets) {
    const template = basename(asset.path);
    if (!template.endsWith(".service")) continue;
    if (!/^OOMScoreAdjust=/m.test(asset.content)) continue;
    units.push(template.endsWith("@.service") ? template.replace(/@\.service$/, `@${instance}.service`) : template);
  }
  return units;
}

const disappeared = (failure: IntegrationFailure): boolean => {
  const code = (unwrapFailure(failure) as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
};

// A proc directory handle keeps the membership check and write tied to the same process if a PID is reused.
const applyProcessOomScore = (pid: string, group: string, score: string) => Effect.acquireUseRelease(
  integration(() => open(`/proc/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY)),
  processDirectory => Effect.gen(function* () {
    const path = `/proc/self/fd/${processDirectory.fd}`;
    const membership = yield* integration(() => readFile(`${path}/cgroup`, "utf8"));
    if (membership.split("\n").includes(`0::${group}`)) yield* integration(() => writeFile(`${path}/oom_score_adj`, score));
  }),
  processDirectory => integration(() => processDirectory.close()).pipe(Effect.orDie),
).pipe(Effect.catch(failure => disappeared(failure) ? Effect.void : Effect.fail(failure)));

/**
 * systemd applies `OOMScoreAdjust=` only when a unit starts, and a live update restarts neither the Platform host
 * nor the Project Agent. Use systemd's effective score, including any administrator drop-ins. A rollback to
 * a template without an explicit score leaves the running processes' scores until restart. cgroup v2 only.
 */
const applyUnitOomScore = Effect.fn("Installation.applyUnitOomScore")(function* (unit: string) {
  const { stdout } = yield* integration(() => execFileAsync("systemctl", ["show", "--property=ControlGroup", "--property=OOMScoreAdjust", "--", unit],
    { maxBuffer: 64 * 1024, timeout: 5_000 }));
  const group = /^ControlGroup=(.*)$/m.exec(stdout)?.[1] ?? "";
  if (group === "") return; // Inactive units take the score when they start.
  if (!/^\/[A-Za-z0-9@._\-/\\]+$/.test(group) || group.split("/").includes("..")) {
    return yield* new IntegrationFailure(new Error(`systemd reported an unusable control group for ${unit}.`));
  }
  const score = /^OOMScoreAdjust=(-?\d{1,4})$/m.exec(stdout)?.[1];
  if (score === undefined || Math.abs(Number(score)) > 1000) {
    return yield* new IntegrationFailure(new Error(`systemd reported an unusable OOM adjustment for ${unit}.`));
  }
  // The operation Agent and its subprocesses run in delegated child cgroups.
  const groups = [group];
  let processCount = 0;
  for (const memberGroup of groups) {
    const directory = `/sys/fs/cgroup${memberGroup}`;
    const listing = yield* integration(() => readFile(`${directory}/cgroup.procs`, "utf8")).pipe(
      Effect.catch(failure => disappeared(failure) ? Effect.succeed("") : Effect.fail(failure)));
    const pids = listing.split("\n").filter(Boolean);
    processCount += pids.length;
    if (processCount > MAX_UNIT_PROCESSES) return yield* new IntegrationFailure(new Error(`${unit} runs more processes than an OOM score update walks.`));
    for (const pid of pids) {
      if (!/^[1-9]\d*$/.test(pid)) return yield* new IntegrationFailure(new Error(`${unit} listed a malformed process id.`));
      yield* applyProcessOomScore(pid, memberGroup, score);
    }
    const entries = yield* integration(() => readdir(directory, { withFileTypes: true })).pipe(
      Effect.catch(failure => disappeared(failure) ? Effect.succeed([]) : Effect.fail(failure)));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (groups.length >= MAX_UNIT_CGROUPS) return yield* new IntegrationFailure(new Error(`${unit} has more cgroups than an OOM score update walks.`));
      groups.push(`${memberGroup}/${entry.name}`);
    }
  }
});

export const applyUnitOomScores = Effect.fn("Installation.applyUnitOomScores")(function* (units: readonly string[]) {
  for (const unit of units) {
    yield* applyUnitOomScore(unit).pipe(Effect.catch(error =>
      Effect.logWarning(`Could not refresh running OOM scores for ${unit}; the unit applies its score at startup: ${error.message}`)));
  }
});
