import { readFile, writeFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { integration } from "../core/runtime/effect-boundary.js";

/** The score `zelavis-agent.service` gives its Projects (`OOMScoreAdjust=`); a test holds the two equal. */
export const PROJECT_OOM_SCORE_ADJ = 200;

/**
 * Ranks this Project ahead of the Platform as the kernel's OOM victim where no systemd unit does: user-mode installs
 * and development run the Platform and its Projects as one account, all at score 0. Any process may raise its own
 * score, and this only ever raises it (a score already at or above this one is kept); its engine, forked
 * later, inherit it.
 * Linux only. A failure leaves the Project at its inherited score and is logged.
 */
export const raiseProjectOomScore = Effect.fn("ProjectHost.raiseOomScore")(function* () {
  if (process.platform !== "linux") return;
  yield* Effect.gen(function* () {
    const current = Number((yield* integration(() => readFile("/proc/self/oom_score_adj", "utf8"))).trim());
    if (Number.isInteger(current) && current >= PROJECT_OOM_SCORE_ADJ) return;
    yield* integration(() => writeFile("/proc/self/oom_score_adj", String(PROJECT_OOM_SCORE_ADJ)));
    // stderr: the host's stdout carries its protocol to the Agent.
  }).pipe(Effect.catch(error => Effect.sync(() => { process.stderr.write(`Project OOM score left as inherited: ${error.message}\n`); })));
});
