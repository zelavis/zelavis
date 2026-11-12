import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { integration, IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";

const execFileAsync = promisify(execFile);
/** More processes than any one unit runs; a cgroup listing past it is not ours to walk. */
const MAX_UNIT_PROCESSES = 16_384;

/**
 * The `OOMScoreAdjust=` each refreshed unit template sets, by the unit it governs. Templates of a named
 * instance (`zelavis@.service`) govern that instance's unit (`zelavis@<instance>.service`).
 */
export function unitOomScores(
  assets: readonly { readonly path: string; readonly content: string }[], instance: string,
): readonly { readonly unit: string; readonly score: number }[] {
  const scores: { unit: string; score: number }[] = [];
  for (const asset of assets) {
    const template = basename(asset.path);
    if (!template.endsWith(".service")) continue;
    const value = /^OOMScoreAdjust=(-?\d{1,4})$/m.exec(asset.content)?.[1];
    if (value === undefined) continue;
    const score = Number(value);
    if (score < -1000 || score > 1000) throw new Error(`${template} sets an OOMScoreAdjust outside -1000..1000.`);
    scores.push({ unit: template.endsWith("@.service") ? template.replace(/@\.service$/, `@${instance}.service`) : template, score });
  }
  return scores;
}

/**
 * systemd applies `OOMScoreAdjust=` only when a unit starts, and a live update restarts neither the Platform host
 * nor the Project Agent. So the root commit gives what already runs in each refreshed unit the score its template
 * now sets; processes forked later inherit it, and the next start takes it from the unit. Rollback leaves the
 * score on running processes (it only ranks OOM victims) until those units start again. cgroup v2 only.
 */
export const applyUnitOomScores = Effect.fn("Installation.applyUnitOomScores")(function* (
  scores: readonly { readonly unit: string; readonly score: number }[],
) {
  for (const { unit, score } of scores) {
    const shown = yield* integration(() => execFileAsync("systemctl", ["show", "--property=ControlGroup", "--value", unit], { maxBuffer: 64 * 1024 }));
    const group = shown.stdout.trim();
    // A unit that is not running has no cgroup; it starts with the template's score.
    if (group === "") continue;
    if (!/^\/[A-Za-z0-9@._\-/\\]+$/.test(group) || group.split("/").includes("..")) {
      return yield* new IntegrationFailure(new Error(`systemd reported an unusable control group for ${unit}.`));
    }
    const listing = (yield* integration(() => readFile(`/sys/fs/cgroup${group}/cgroup.procs`, "utf8"))).split("\n").filter(Boolean);
    if (listing.length > MAX_UNIT_PROCESSES) return yield* new IntegrationFailure(new Error(`${unit} runs more processes than an OOM score update walks.`));
    for (const pid of listing) {
      if (!/^\d+$/.test(pid)) return yield* new IntegrationFailure(new Error(`${unit} listed a malformed process id.`));
      yield* integration(() => writeFile(`/proc/${pid}/oom_score_adj`, String(score))).pipe(Effect.catch(failure => {
        const code = (unwrapFailure(failure) as NodeJS.ErrnoException | undefined)?.code;
        // A process that exited since the listing needs no score.
        return code === "ENOENT" || code === "ESRCH" ? Effect.void : Effect.fail(failure);
      }));
    }
  }
});
