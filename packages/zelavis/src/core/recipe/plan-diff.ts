import { Data, Order, Array as Arr } from "effect";
import type { ProcessUpdate } from "./recipe.js";

/**
 * What changing one process plan into another means for the processes already running.
 *
 * This module is pure: it decides, from fingerprints, which processes to leave alone, which to
 * signal, which to replace, which to start and which to stop, and in what order. Doing it is
 * `plan-controller.ts`'s job. Keeping the decision free of any process or clock is what lets it
 * be tested exhaustively, and what makes "an upgrade that changes nothing restarts nothing" a
 * property of the plan comparison rather than a hope.
 *
 * Fingerprints hold digests, never the values they were made from: a launch may carry secrets.
 */

/** Two digests: how the process was launched, and what its configuration files held. */
export interface Fingerprint {
  /** SHA-256 over executable, arguments, environment and directory. */
  readonly launch: string;
  /** SHA-256 over the content of its declared configuration files. */
  readonly config: string;
}

export interface LiveProcess {
  readonly name: string;
  readonly fingerprint: Fingerprint;
  readonly dependsOn: readonly string[];
  /** Whether the Agent still reports it running. A process that died is not "kept". */
  readonly alive: boolean;
}

export interface WantedProcess {
  readonly name: string;
  readonly fingerprint: Fingerprint;
  readonly dependsOn: readonly string[];
  readonly update: ProcessUpdate;
}

export type ReplaceReason = "launch" | "config" | "exited";

export type Step = Data.TaggedEnum<{
  /** Running, unchanged: nothing is done. */
  Keep: { readonly name: string };
  /** Running, only its configuration changed, and it reloads: signalled, never stopped. */
  Reload: { readonly name: string; readonly signal: "SIGHUP" | "SIGUSR1" | "SIGUSR2" };
  /** Stopped and started again from the new plan. */
  Replace: { readonly name: string; readonly reason: ReplaceReason };
  /** Not running: started. */
  Add: { readonly name: string };
  /** Running but no longer in the plan: stopped. */
  Remove: { readonly name: string };
}>;
export const Step = Data.taggedEnum<Step>();

/** Dependency levels of a set of named processes: each level depends only on earlier ones. */
export function dependencyLevels(
  nodes: readonly { readonly name: string; readonly dependsOn: readonly string[] }[],
): readonly (readonly string[])[] {
  const known = new Set(nodes.map((node) => node.name));
  const placed = new Set<string>();
  const levels: string[][] = [];
  let remaining = [...nodes];
  while (remaining.length > 0) {
    // A dependency outside the set (a removed process's) cannot hold anything back.
    const ready = remaining.filter((node) => node.dependsOn.every((dependency) => placed.has(dependency) || !known.has(dependency)));
    if (ready.length === 0) throw new Error("Process dependencies contain a cycle.");
    levels.push(ready.map((node) => node.name).sort(Order.String));
    for (const node of ready) placed.add(node.name);
    remaining = remaining.filter((node) => !placed.has(node.name));
  }
  return levels;
}

/**
 * The steps that turn `live` into `wanted`, as groups: the steps of one group are independent and
 * may run together, and a group runs only after the one before it is done.
 *
 * Wanted processes come first, dependencies before dependents, so a dependency is ready before
 * what needs it starts. Removals come last, dependents before dependencies, so nothing is stopped
 * out from under something that still uses it. Nothing cascades: replacing a process does not
 * replace its dependents (a database restart does not restart the web tier that reconnects to it).
 */
export function planSteps(live: readonly LiveProcess[], wanted: readonly WantedProcess[]): readonly (readonly Step[])[] {
  const running = new Map(live.map((process) => [process.name, process]));
  const wantedNames = new Set(wanted.map((process) => process.name));
  const byName = new Map(wanted.map((process) => [process.name, process]));

  const forward = dependencyLevels(wanted).map((level) => level.map((name): Step => {
    const target = byName.get(name)!;
    const current = running.get(name);
    if (current === undefined) return Step.Add({ name });
    if (!current.alive) return Step.Replace({ name, reason: "exited" });
    if (current.fingerprint.launch !== target.fingerprint.launch) return Step.Replace({ name, reason: "launch" });
    if (current.fingerprint.config === target.fingerprint.config) return Step.Keep({ name });
    return target.update.strategy === "reload"
      ? Step.Reload({ name, signal: target.update.signal })
      : Step.Replace({ name, reason: "config" });
  }));

  const leaving = live.filter((process) => !wantedNames.has(process.name));
  const removals = Arr.reverse(dependencyLevels(leaving)).map((level) => level.map((name) => Step.Remove({ name })));
  return [...forward, ...removals];
}

/** Whether applying these steps changes anything at all. */
export const changesNothing = (steps: readonly (readonly Step[])[]): boolean =>
  steps.every((group) => group.every((step) => step._tag === "Keep"));
